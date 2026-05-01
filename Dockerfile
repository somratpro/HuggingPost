# ============================================================================
# HuggingPost — Postiz v2.11.3 on Hugging Face Spaces
#
# Three-stage build to beat the HF Space builder memory limit:
#
#   Stage 1 (postiz-builder):  clone, patch, install deps,
#                               build backend + workers + cron.
#   Stage 2 (postiz-frontend): copy tree from Stage 1, build ONLY the
#                               Next.js frontend in a clean process.
#                               Stage 1's processes are dead → their RSS
#                               is fully freed before `next build` starts.
#   Stage 3 (runtime):         copy server build from Stage 1,
#                               overlay frontend .next from Stage 2.
#
# Why three stages (not two):
#   Three NestJS builds (backend+workers+cron) leave ~1-2 GB of residual
#   RSS in the same container even after each `pnpm run build:*` exits,
#   because the OS hasn't reclaimed all pages. `next build` alone needs
#   ~3-4 GB RSS (V8 heap + SWC + native addons). Together they exceed
#   the HF builder cgroup limit → OOMKilled (exit 137).
#   Splitting frontend into its own stage gives it a clean address space.
#
# Container layout at runtime:
#   - nginx (port 5000, internal)        — Postiz frontend + backend + uploads
#   - PM2 → 4 Postiz procs (backend/frontend/workers/cron)
#   - postgres (port 5432, internal)
#   - redis    (port 6379, internal)
#   - postiz-sync.py loop                — backup DB + uploads to HF Dataset
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

# Patch Next.js config:
#   1. basePath/assetPrefix=/app  → Postiz UI mounts at /app; dashboard owns /
#   2. productionBrowserSourceMaps: false  → saves ~500 MB RSS during emit
#   3. Sentry sourcemap plugin: disable: true  → saves another ~300 MB
#   4. experimental.cpus=1 + workerThreads=false  → single-thread webpack;
#      no parallel worker copies of the module graph in memory
RUN sed -i "s|const nextConfig = {|const nextConfig = {\n  basePath: '/app',\n  assetPrefix: '/app',|" apps/frontend/next.config.js \
    && sed -i "s|productionBrowserSourceMaps: true|productionBrowserSourceMaps: false|" apps/frontend/next.config.js \
    && sed -i "s|disable: false,|disable: true,|" apps/frontend/next.config.js \
    && sed -i "s|experimental: {|experimental: {\n    cpus: 1,\n    workerThreads: false,|" apps/frontend/next.config.js \
    && grep -q "basePath: '/app'" apps/frontend/next.config.js \
    && grep -q "productionBrowserSourceMaps: false" apps/frontend/next.config.js \
    && grep -q "cpus: 1" apps/frontend/next.config.js \
    || (echo "PATCH FAILED — next.config.js shape changed upstream"; exit 1)

# Sentry env stubs — keep transitive Sentry imports from doing network calls.
ENV SENTRY_DSN="" \
    SENTRY_AUTH_TOKEN="" \
    SENTRY_ORG="" \
    SENTRY_PROJECT="" \
    NEXT_PUBLIC_SENTRY_DSN="" \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PRIVATE_SKIP_SIZE_MINIMIZATION=true

# Install all deps (shared pnpm virtual store for all workspace packages).
RUN pnpm install --frozen-lockfile=false

# Build server-side apps sequentially at 3 GB heap each.
# Frontend is intentionally excluded — built in its own stage below.
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:backend
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:workers
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:cron

# Clean up dev artefacts before Stage 3 copies this tree into the runtime image.
RUN find . -name ".git" -type d -prune -exec rm -rf {} + 2>/dev/null || true \
 && rm -rf .github reports Jenkins .devcontainer 2>/dev/null || true


# ── Stage 2: Build Next.js frontend in isolation ──────────────────────────────
FROM node:22.20-alpine AS postiz-frontend

WORKDIR /build

# pnpm must be present to run workspace scripts.
RUN npm install -g pnpm@10.6.1

# Copy the full build tree from Stage 1:
#   - patched apps/frontend/next.config.js
#   - node_modules (pnpm virtual store, all symlinks intact within the tree)
#   - already-built server apps (needed for any cross-package type references)
# Stage 1's processes are dead here → its RSS is freed by the OS.
# next build therefore starts with a clean address space.
COPY --from=postiz-builder /build /build

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PRIVATE_SKIP_SIZE_MINIMIZATION=true \
    SENTRY_DSN="" \
    SENTRY_AUTH_TOKEN="" \
    SENTRY_ORG="" \
    SENTRY_PROJECT="" \
    NEXT_PUBLIC_SENTRY_DSN=""

RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:frontend


# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:22.20-alpine

WORKDIR /app

# System deps — same set as upstream's Dockerfile.dev (bash, nginx, py3-pip)
# plus postgres + redis + extras we need.
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

# pnpm + pm2 to run Postiz processes the same way upstream does
RUN npm install -g pnpm@10.6.1 pm2

# Python deps for HF Dataset sync
RUN pip install --no-cache-dir --break-system-packages \
    huggingface_hub \
    PyYAML

# Copy server-side build (backend + workers + cron + node_modules, cleaned).
COPY --from=postiz-builder /build /app

# Overlay the compiled Next.js frontend from its isolated build stage.
COPY --from=postiz-frontend /build/apps/frontend/.next /app/apps/frontend/.next

# Use upstream's nginx.conf — routes /api→3000, /uploads→fs, /→4200.
# health-server strips /app before forwarding, so nginx sees expected paths.
COPY --from=postiz-builder /build/var/docker/nginx.conf /etc/nginx/nginx.conf

# Health-server lives outside /app so its node_modules don't collide with
# Postiz's pnpm workspaces.
RUN mkdir -p /opt/healthsrv && cd /opt/healthsrv && \
    npm init -y >/dev/null && \
    npm install --no-save --no-audit --no-fund express@4 cors morgan

# Postgres/Redis/uploads dirs — all under /postiz so postiz-sync.py can
# include them in the backup tarball.
RUN mkdir -p /var/run/postgresql /postiz/pgdata /postiz/redis /postiz/uploads /postiz/.secrets \
    && chown -R postgres:postgres /var/run/postgresql /postiz/pgdata \
    && chmod 700 /postiz/pgdata

# Symlink /uploads → /postiz/uploads so nginx's `alias /uploads/` picks up
# media stored in the persisted tree.
RUN ln -sf /postiz/uploads /uploads

# Copy orchestration files
COPY start.sh /opt/start.sh
COPY health-server.js /opt/healthsrv/health-server.js
COPY postiz-sync.py /opt/postiz-sync.py
COPY cloudflare-proxy.js /opt/cloudflare-proxy.js
COPY cloudflare-proxy-setup.py /opt/cloudflare-proxy-setup.py
COPY cloudflare-worker.js /opt/cloudflare-worker.js
COPY setup-uptimerobot.sh /opt/setup-uptimerobot.sh

RUN chmod +x /opt/start.sh /opt/setup-uptimerobot.sh

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

CMD ["/opt/start.sh"]
