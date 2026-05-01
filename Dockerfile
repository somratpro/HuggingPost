# ============================================================================
# HuggingPost — Postiz v2.11.3 on Hugging Face Spaces
#
# Builds Postiz from source with a Next.js basePath="/app" patch so the
# Postiz UI mounts at /app/* and our HuggingPost dashboard owns /.
#
# Why source build (not the prebuilt ghcr image): Next.js basePath is
# build-time. The official image bakes basePath="/" into the static bundle,
# so we'd be unable to relocate the UI to /app without rebuilding.
#
# Container layout:
#   - nginx (port 5000, internal)        — Postiz frontend + backend + uploads
#   - PM2 → 4 Postiz procs (backend/frontend/workers/cron)
#   - postgres (port 5432, internal)
#   - redis    (port 6379, internal)
#   - postiz-sync.py loop                — backup DB + uploads to HF Dataset
#   - health-server.js (port 7860, public) — dashboard + reverse proxy
# ============================================================================

# ── Stage 1: Build Postiz with /app basePath patch ───────────────────────────
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

# Patch Next.js config to mount the frontend at /app.
# We inject basePath + assetPrefix immediately after `const nextConfig = {`.
# This makes Next.js generate links/asset URLs prefixed with /app, so the
# browser will hit /app/_next/* etc., which our health-server then strips
# back to /_next/* before passing to nginx.
RUN sed -i "s|const nextConfig = {|const nextConfig = {\n  basePath: '/app',\n  assetPrefix: '/app',|" apps/frontend/next.config.js \
    && grep -q "basePath: '/app'" apps/frontend/next.config.js \
    || (echo "BASEPATH PATCH FAILED — next.config.js shape changed upstream"; exit 1)

# Install + build. 4 GB heap for the Next.js compile.
RUN pnpm install --frozen-lockfile=false
RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build

# Drop dev junk to shrink the runtime image.
RUN find . -name ".git" -type d -prune -exec rm -rf {} + 2>/dev/null || true \
 && rm -rf .github reports Jenkins .devcontainer 2>/dev/null || true


# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
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

# Copy fully-built Postiz into /app
COPY --from=postiz-builder /build /app

# Use upstream's nginx.conf — defines the routing nginx :5000 → backend :3000
# (under /api), uploads alias, and frontend :4200 (under /). HuggingPost's
# health-server already strips /app before forwarding here, so nginx sees
# the same paths it expects in the upstream layout.
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
