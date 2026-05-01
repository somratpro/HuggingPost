# ============================================================================
# HuggingPost — Postiz v2.11.3 on Hugging Face Spaces
#
# Two-stage build: compile only the server-side apps (backend/workers/cron)
# during docker build. The Next.js frontend is intentionally NOT built here.
#
# Why: `next build` for Postiz needs ~4 GB RSS. The HF Space builder has a
# ~4 GB cgroup limit, so it always OOMKills the process (exit 137) regardless
# of heap tuning, parallel/single-thread settings, or multi-stage tricks.
#
# Solution: build the frontend in start.sh at container startup, where the
# runtime has 16 GB RAM. The compiled .next is included in the HF Dataset
# backup so subsequent restarts skip the build entirely.
#
# First boot:  ~5-8 min (server apps start immediately; frontend compiles in
#              background, then Postiz frontend process starts when done).
# Later boots: .next restored from backup → Postiz starts normally (~90 s).
#
# Container layout at runtime:
#   - nginx (port 5000, internal)         — Postiz frontend + backend + uploads
#   - PM2 → 4 Postiz procs (backend / frontend / workers / cron)
#   - postgres (port 5432, internal)
#   - redis    (port 6379, internal)
#   - postiz-sync.py loop                 — backup DB + uploads + .next
#   - health-server.js (port 7860, public) — dashboard + reverse proxy
# ============================================================================

# ── Stage 1: Clone, patch, install deps, build server apps ───────────────────
FROM node:22.20-alpine AS postiz-builder

WORKDIR /build

ARG NEXT_PUBLIC_VERSION=v2.11.3
ENV NEXT_PUBLIC_VERSION=$NEXT_PUBLIC_VERSION

RUN apk add --no-cache \
    git \
    g++ \
    make \
    py3-pip \
    bash

RUN npm install -g pnpm@10.6.1

# Pinned to v2.11.3 — last release before Temporal became a hard requirement.
RUN git clone --depth=1 --branch v2.11.3 https://github.com/gitroomhq/postiz-app.git .

# Patch Next.js config — applied now so the patched file is in the image and
# `pnpm run build:frontend` in start.sh picks up all settings automatically.
#   1. basePath/assetPrefix=/app   → Postiz UI at /app; HuggingPost dashboard owns /
#   2. productionBrowserSourceMaps: false  → smaller build output
#   3. Sentry sourcemap plugin disabled   → no network calls during build
#   4. swcMinify: false  → Terser (pure JS) instead of native SWC binary;
#      avoids extra RSS outside the V8 heap
#   5. experimental.cpus=1 + workerThreads=false  → single-thread webpack
RUN sed -i "s|const nextConfig = {|const nextConfig = {\n  basePath: '/app',\n  assetPrefix: '/app',\n  swcMinify: false,|" apps/frontend/next.config.js \
    && sed -i "s|productionBrowserSourceMaps: true|productionBrowserSourceMaps: false|" apps/frontend/next.config.js \
    && sed -i "s|disable: false,|disable: true,|" apps/frontend/next.config.js \
    && sed -i "s|experimental: {|experimental: {\n    cpus: 1,\n    workerThreads: false,|" apps/frontend/next.config.js \
    && grep -q "basePath: '/app'" apps/frontend/next.config.js \
    && grep -q "productionBrowserSourceMaps: false" apps/frontend/next.config.js \
    && grep -q "swcMinify: false" apps/frontend/next.config.js \
    && grep -q "cpus: 1" apps/frontend/next.config.js \
    || (echo "PATCH FAILED — next.config.js shape changed upstream"; exit 1)

ENV SENTRY_DSN="" \
    SENTRY_AUTH_TOKEN="" \
    SENTRY_ORG="" \
    SENTRY_PROJECT="" \
    NEXT_PUBLIC_SENTRY_DSN="" \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PRIVATE_SKIP_SIZE_MINIMIZATION=true

RUN pnpm install --frozen-lockfile=false

# Build server-side apps. Sequential + 3 GB heap each.
# Frontend is NOT built here — see start.sh.
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:backend
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:workers
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:cron

# Clean up dev artefacts before Stage 2 copies this tree into the runtime image.
RUN find . -name ".git" -type d -prune -exec rm -rf {} + 2>/dev/null || true \
 && rm -rf .github reports Jenkins .devcontainer 2>/dev/null || true


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22.20-alpine

WORKDIR /app

RUN apk add --no-cache \
    bash \
    curl \
    ca-certificates \
    openssl \
    jq \
    nginx \
    postgresql16 \
    postgresql16-contrib \
    postgresql16-client \
    redis \
    py3-pip \
    su-exec

# nginx user — upstream uses 'www'. Mirror that so its nginx.conf works.
RUN adduser -D -g 'www' www \
    && mkdir -p /var/lib/nginx /var/log/nginx \
    && chown -R www:www /var/lib/nginx

RUN npm install -g pnpm@10.6.1 pm2

RUN pip install --no-cache-dir --break-system-packages \
    huggingface_hub \
    PyYAML

# Copy fully-built Postiz server apps + node_modules + patched next.config.js.
# .next is intentionally absent here; start.sh builds or restores it at boot.
COPY --from=postiz-builder /build /app

# nginx.conf: routes /api→3000, /uploads→fs, /→4200.
# Patch: re-add /app prefix before proxying to Next.js (port 4200) because:
#   health-server strips /app from incoming /app/* requests before forwarding
#   to nginx. Next.js is built with basePath="/app" so it expects /app/* paths.
#   Without the patch, nginx sends /auth/login → Next.js returns 404.
#   With the patch, nginx sends /app/auth/login → Next.js handles it correctly.
COPY --from=postiz-builder /build/var/docker/nginx.conf /etc/nginx/nginx.conf
RUN sed -i 's|proxy_pass http://127.0.0.1:4200/;|proxy_pass http://127.0.0.1:4200/app/;|; s|proxy_pass http://localhost:4200/;|proxy_pass http://localhost:4200/app/;|' /etc/nginx/nginx.conf \
    && grep -q '/app/' /etc/nginx/nginx.conf \
    || (echo "NGINX PATCH FAILED — upstream nginx.conf format changed"; cat /etc/nginx/nginx.conf; exit 1)

# Health-server outside /app to avoid pnpm workspace collisions.
RUN mkdir -p /opt/healthsrv && cd /opt/healthsrv && \
    npm init -y >/dev/null && \
    npm install --no-save --no-audit --no-fund express@4 cors morgan

RUN mkdir -p /var/run/postgresql /postiz/pgdata /postiz/redis /postiz/uploads /postiz/.secrets \
    && chown -R postgres:postgres /var/run/postgresql /postiz/pgdata \
    && chmod 700 /postiz/pgdata

RUN ln -sf /postiz/uploads /uploads

COPY start.sh /opt/start.sh
COPY health-server.js /opt/healthsrv/health-server.js
COPY postiz-sync.py /opt/postiz-sync.py
COPY cloudflare-proxy.js /opt/cloudflare-proxy.js
COPY cloudflare-proxy-setup.py /opt/cloudflare-proxy-setup.py
COPY cloudflare-worker.js /opt/cloudflare-worker.js
COPY setup-uptimerobot.sh /opt/setup-uptimerobot.sh

RUN chmod +x /opt/start.sh /opt/setup-uptimerobot.sh

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=5 \
    CMD curl -f http://localhost:7860/health || exit 1

CMD ["/opt/start.sh"]
