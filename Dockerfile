# ============================================================================
# HuggingPost — Postiz v2.11.3 on Hugging Face Spaces
#
# Three-stage build to beat the HF Space builder memory limit:
#
#   Stage 1 (postiz-builder):   clone → patch → full install →
#                                build backend + workers + cron
#   Stage 2 (postiz-frontend):  fresh clone → patch → FILTERED install
#                                (frontend dep tree only, skips NestJS/
#                                Prisma/bcrypt/etc.) → build Next.js
#   Stage 3 (runtime):          COPY server build from Stage 1
#                                overlay .next from Stage 2
#
# Why fresh clone in Stage 2 (not COPY from Stage 1):
#   COPY --from=stage1 /build /build copies ~2 GB of node_modules (3817
#   packages). BuildKit decompresses that as a layer; the OS page-caches it.
#   Then next build loads its own module graph on top. Combined RSS exceeds
#   the builder cgroup limit → exit 137 OOMKilled.
#   A filtered pnpm install in a fresh Stage 2 pulls only the frontend
#   package's npm dependency tree — maybe 30-50% of the full install —
#   so peak RSS stays within limits.
#
# Container layout at runtime:
#   - nginx (port 5000, internal)         — Postiz frontend + backend + uploads
#   - PM2 → 4 Postiz procs (backend / frontend / workers / cron)
#   - postgres (port 5432, internal)
#   - redis    (port 6379, internal)
#   - postiz-sync.py loop                 — backup DB + uploads to HF Dataset
#   - health-server.js (port 7860, public) — dashboard + reverse proxy
# ============================================================================

# ── Stage 1: Clone, patch, full install, build server apps ───────────────────
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

# Patch Next.js config (applied here so Stage 2's fresh clone also patches).
# Stage 2 re-applies the same sed commands on its own clone.
#   1. basePath/assetPrefix=/app  → Postiz UI at /app; dashboard owns /
#   2. productionBrowserSourceMaps: false  → shaves ~500 MB RSS during emit
#   3. Sentry sourcemap plugin: disable: true  → saves ~300 MB
#   4. swcMinify: false  → forces Terser (pure JS, V8-heap-bounded) instead
#      of the native SWC binary that adds RSS outside the V8 heap limit
#   5. experimental.cpus=1 + workerThreads=false  → single-thread webpack;
#      no parallel worker copies of the module graph eating extra RAM
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

# Full install — backend, workers, cron all need the complete dep tree.
RUN pnpm install --frozen-lockfile=false

# Build server-side apps only. Frontend is built in its own isolated stage.
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:backend
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:workers
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:cron

# Remove dev artefacts before Stage 3 copies this tree into the runtime image.
RUN find . -name ".git" -type d -prune -exec rm -rf {} + 2>/dev/null || true \
 && rm -rf .github reports Jenkins .devcontainer 2>/dev/null || true


# ── Stage 2: Build Next.js frontend with minimal dep tree ────────────────────
FROM node:22.20-alpine AS postiz-frontend

WORKDIR /build

RUN apk add --no-cache git bash
RUN npm install -g pnpm@10.6.1

# Fresh clone — gives a clean slate with no Stage 1 memory residue.
RUN git clone --depth=1 --branch v2.11.3 https://github.com/gitroomhq/postiz-app.git .

# Apply the same patches as Stage 1.
RUN sed -i "s|const nextConfig = {|const nextConfig = {\n  basePath: '/app',\n  assetPrefix: '/app',\n  swcMinify: false,|" apps/frontend/next.config.js \
    && sed -i "s|productionBrowserSourceMaps: true|productionBrowserSourceMaps: false|" apps/frontend/next.config.js \
    && sed -i "s|disable: false,|disable: true,|" apps/frontend/next.config.js \
    && sed -i "s|experimental: {|experimental: {\n    cpus: 1,\n    workerThreads: false,|" apps/frontend/next.config.js \
    && grep -q "basePath: '/app'" apps/frontend/next.config.js \
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

# Filtered install — pulls only packages in the frontend's dependency tree.
# Skips NestJS, Prisma, bcrypt, Bull, and other server-only packages.
# Results in a much smaller node_modules → less OS page cache pressure
# → lower peak RSS during next build.
RUN pnpm install --filter "./apps/frontend..." --frozen-lockfile=false

# Build Next.js frontend in isolation.
# Stage 1's processes are dead; Stage 2 starts with a clean address space.
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm run build:frontend


# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
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

# Copy server build (backend + workers + cron + full node_modules, cleaned).
COPY --from=postiz-builder /build /app

# Overlay the compiled Next.js frontend from the isolated build stage.
# This overwrites the empty apps/frontend/.next placeholder in the tree above.
COPY --from=postiz-frontend /build/apps/frontend/.next /app/apps/frontend/.next

# Use upstream's nginx.conf — routes /api→3000, /uploads→fs, /→4200.
COPY --from=postiz-builder /build/var/docker/nginx.conf /etc/nginx/nginx.conf

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

HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

CMD ["/opt/start.sh"]
