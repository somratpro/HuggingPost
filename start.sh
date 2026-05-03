#!/bin/bash
# ============================================================================
# HuggingPost orchestrator
#
# Boot order:
#   1. Compute env (DB_URL, REDIS_URL, FRONTEND_URL, basePath-aware backend URL)
#   2. Persist or generate JWT_SECRET, DB password
#   3. Init Postgres data dir if empty, start postgres, create user + DB
#   4. Start Redis
#   5. Restore DB + uploads + secrets from HF Dataset (if HF_TOKEN set)
#   6. Background: HF Dataset sync loop
#   7. Background: nginx + PM2 (the 4 Postiz procs — same CMD as upstream)
#   8. Foreground: health-server.js on port 7860
#   9. SIGTERM → final sync → graceful exit
# ============================================================================

set -euo pipefail
umask 0077

# ── Paths ────────────────────────────────────────────────────────────────────
POSTIZ_HOME="/postiz"
POSTIZ_DIR="/app"
PGDATA="${POSTIZ_HOME}/pgdata"
SECRETS_DIR="${POSTIZ_HOME}/.secrets"
JWT_SECRET_FILE="${SECRETS_DIR}/jwt-secret"
DB_PASSWORD_FILE="${SECRETS_DIR}/db-password"
mkdir -p "${POSTIZ_HOME}/uploads" "${POSTIZ_HOME}/redis" "${SECRETS_DIR}"

# ── Public URL ───────────────────────────────────────────────────────────────
if [ -n "${SPACE_HOST:-}" ]; then
    PUBLIC_URL="https://${SPACE_HOST}"
else
    PUBLIC_URL="${PUBLIC_URL:-http://localhost:7860}"
fi

# ── JWT_SECRET (persist across restarts) ─────────────────────────────────────
if [ -z "${JWT_SECRET:-}" ]; then
    if [ -f "${JWT_SECRET_FILE}" ]; then
        JWT_SECRET=$(cat "${JWT_SECRET_FILE}")
    else
        JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
        printf '%s' "${JWT_SECRET}" > "${JWT_SECRET_FILE}"
        chmod 600 "${JWT_SECRET_FILE}"
    fi
    export JWT_SECRET
fi

# ── DB password (random hex, persisted) ──────────────────────────────────────
if [ -f "${DB_PASSWORD_FILE}" ]; then
    DB_PASSWORD=$(cat "${DB_PASSWORD_FILE}")
else
    DB_PASSWORD=$(openssl rand -hex 24)
    printf '%s' "${DB_PASSWORD}" > "${DB_PASSWORD_FILE}"
    chmod 600 "${DB_PASSWORD_FILE}"
fi
export PGPASSWORD="${DB_PASSWORD}"

# ── Postiz env (UI mounted at /app, API at /app/api) ────────────────────────
# basePath="/app" was patched into apps/frontend/next.config.js at build time,
# so Next.js generates URLs prefixed with /app. NEXT_PUBLIC_BACKEND_URL must
# include /app/api so frontend code calls the right path; health-server
# strips /app before passing to nginx :5000, which then routes /api → backend
# (port 3000) and /uploads → file system.
#
# FRONTEND_URL must be the bare origin (scheme+host, NO /app path suffix).
# The backend uses this for the CORS allow-origin response header. Browsers
# send Origin: https://host (no path), so including /app causes a mismatch
# and blocks every API call (login, signup, etc.).
export DATABASE_URL="${DATABASE_URL:-postgresql://postiz:${DB_PASSWORD}@localhost:5432/postiz}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export FRONTEND_URL="${FRONTEND_URL:-${PUBLIC_URL}}"
export MAIN_URL="${MAIN_URL:-${PUBLIC_URL}}"
export NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-${PUBLIC_URL}/app/api}"
export BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://localhost:3000}"
export STORAGE_PROVIDER="${STORAGE_PROVIDER:-local}"
export UPLOAD_DIRECTORY="${UPLOAD_DIRECTORY:-${POSTIZ_HOME}/uploads}"
export NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY="${NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY:-/app/uploads}"
export IS_GENERAL="${IS_GENERAL:-true}"
export NX_ADD_PLUGINS="${NX_ADD_PLUGINS:-false}"
export NODE_ENV="${NODE_ENV:-production}"
# HF Space proxy rewrites Set-Cookie Domain to .hf.space which is a public
# suffix — browsers reject such cookies. NOT_SECURED=true makes the backend
# also send the JWT as an `auth` response header; the frontend JS reads it
# and sets the cookie via document.cookie (no domain attr) so it lands on
# the exact hostname and the browser accepts it.
export NOT_SECURED="${NOT_SECURED:-true}"

# Sync config
export SYNC_INTERVAL="${SYNC_INTERVAL:-3600}"  # 60 minutes (override with SYNC_INTERVAL secret)
export SYNC_MAX_FILE_BYTES="${SYNC_MAX_FILE_BYTES:-524288000}"  # 500 MB (default; covers .next + DB + uploads)
export BACKUP_DATASET_NAME="${BACKUP_DATASET_NAME:-huggingpost-backup}"

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo "  ╔════════════════════════════════════╗"
echo "  ║          HuggingPost               ║"
echo "  ║  Postiz on Hugging Face Spaces     ║"
echo "  ╚════════════════════════════════════╝"
echo ""
echo "Public host  : ${SPACE_HOST:-not detected}"
echo "Dashboard    : ${PUBLIC_URL}/"
echo "Postiz UI    : ${PUBLIC_URL}/app/"
echo "Postiz API   : ${PUBLIC_URL}/app/api/"
echo "Sync every   : ${SYNC_INTERVAL}s"
echo "HF backup    : $([ -n "${HF_TOKEN:-}" ] && echo 'enabled' || echo 'disabled (no HF_TOKEN)')"
echo ""

# ── Postgres ─────────────────────────────────────────────────────────────────
PG_BIN="/usr/libexec/postgresql16"
[ -x "${PG_BIN}/postgres" ] || PG_BIN="/usr/bin"

if [ ! -f "${PGDATA}/PG_VERSION" ]; then
    echo "Initializing Postgres cluster at ${PGDATA}..."
    chown -R postgres:postgres "${PGDATA}"
    su-exec postgres "${PG_BIN}/initdb" -D "${PGDATA}" --locale=C.UTF-8 --encoding=UTF8 >/dev/null
    echo "host all all 127.0.0.1/32 scram-sha-256" >> "${PGDATA}/pg_hba.conf"
fi

chown -R postgres:postgres "${PGDATA}"

if ! su-exec postgres "${PG_BIN}/pg_ctl" -D "${PGDATA}" status >/dev/null 2>&1; then
    echo "Starting Postgres..."
    su-exec postgres "${PG_BIN}/pg_ctl" -D "${PGDATA}" \
        -l "/tmp/pg.log" \
        -o "-c listen_addresses='127.0.0.1' -c unix_socket_directories='/var/run/postgresql'" \
        start >/dev/null
fi

for _ in $(seq 1 30); do
    su-exec postgres pg_isready -h 127.0.0.1 >/dev/null 2>&1 && break
    sleep 1
done

su-exec postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='postiz'" | grep -q 1 \
    || su-exec postgres psql -c "CREATE ROLE postiz WITH LOGIN PASSWORD '${DB_PASSWORD}';" >/dev/null
su-exec postgres psql -c "ALTER ROLE postiz WITH PASSWORD '${DB_PASSWORD}';" >/dev/null
su-exec postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='postiz'" | grep -q 1 \
    || su-exec postgres psql -c "CREATE DATABASE postiz OWNER postiz;" >/dev/null

echo "Postgres ready"

# ── Redis ────────────────────────────────────────────────────────────────────
echo "Starting Redis..."
redis-server --daemonize yes \
    --bind 127.0.0.1 \
    --port 6379 \
    --appendonly yes \
    --dir "${POSTIZ_HOME}/redis" \
    --logfile /tmp/redis.log

for _ in $(seq 1 10); do
    redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG && break
    sleep 1
done
echo "Redis ready"

# ── Restore from HF Dataset ──────────────────────────────────────────────────
if [ -n "${HF_TOKEN:-}" ]; then
    echo "Restoring persisted data from HF Dataset..."
    python3 /opt/postiz-sync.py restore 2>&1 || true
    if [ -f "${DB_PASSWORD_FILE}" ]; then
        DB_PASSWORD=$(cat "${DB_PASSWORD_FILE}")
        export PGPASSWORD="${DB_PASSWORD}"
        export DATABASE_URL="postgresql://postiz:${DB_PASSWORD}@localhost:5432/postiz"
    fi
    su-exec postgres psql -c "ALTER ROLE postiz WITH PASSWORD '${DB_PASSWORD}';" >/dev/null 2>&1 || true
else
    echo "HF_TOKEN not set — running without backup persistence"
    echo "   Add HF_TOKEN as a Space secret to enable DB+uploads backup."
fi

# ── Patch next/font/google → next/font/local (runtime safety net) ────────────
# Docker Stage 1 may be cached from before this patch was introduced.
# Apply here unconditionally so the cached image is fixed at container start.
# No-op if layout.tsx already uses next/font/local (idempotent grep check).
_APP_LAYOUT="${POSTIZ_DIR}/apps/frontend/src/app/(app)/layout.tsx"
if grep -q "next/font/google" "${_APP_LAYOUT}" 2>/dev/null; then
    echo "Patching next/font/google → next/font/local (cached image lacks build-time patch)..."
    mkdir -p "${POSTIZ_DIR}/apps/frontend/src/fonts"
    cp /opt/vendor/fonts/*.woff2 "${POSTIZ_DIR}/apps/frontend/src/fonts/"
    cd "${POSTIZ_DIR}"
    node /opt/vendor/patch-jakarta-font.js
    cd /
    echo "Font patch applied."
else
    echo "Font patch: layout.tsx already uses next/font/local — skipping."
fi

# ── Build Next.js frontend (first boot or after next.config.js change) ───────
# next build is NOT run during docker build — the HF builder's ~4 GB cgroup
# limit is less than what next build needs. We run it here where the runtime
# has 16 GB. On subsequent starts the .next directory is restored from the
# HF Dataset backup, so this block only executes once per config version.
#
# Config-hash check: if next.config.js changed (new image deploy), the stored
# hash inside .next won't match — we rebuild automatically even if BUILD_ID
# exists. This avoids serving a .next compiled with stale settings.
FRONTEND_NEXT="${POSTIZ_DIR}/apps/frontend/.next"
CONFIG_HASH=$(md5sum "${POSTIZ_DIR}/apps/frontend/next.config.js" 2>/dev/null | cut -d' ' -f1 || echo "none")
STORED_HASH=$(cat "${FRONTEND_NEXT}/.config-hash" 2>/dev/null || echo "")

if [ ! -f "${FRONTEND_NEXT}/BUILD_ID" ] || [ "${CONFIG_HASH}" != "${STORED_HASH}" ]; then
    if [ "${CONFIG_HASH}" != "${STORED_HASH}" ] && [ -f "${FRONTEND_NEXT}/BUILD_ID" ]; then
        echo ""
        echo "  next.config.js changed — rebuilding frontend (~5 min)..."
        echo ""
    else
        echo ""
        echo "  ┌─────────────────────────────────────────────────────────────────┐"
        echo "  │  Building Next.js frontend (first boot — takes ~5 min)          │"
        echo "  │  Dashboard is live at ${PUBLIC_URL}/                             │"
        echo "  │  Postiz will start automatically when the build finishes.        │"
        echo "  └─────────────────────────────────────────────────────────────────┘"
        echo ""
    fi
    cd "${POSTIZ_DIR}"
    SENTRY_DSN="" \
    SENTRY_AUTH_TOKEN="" \
    SENTRY_ORG="" \
    SENTRY_PROJECT="" \
    NEXT_PUBLIC_SENTRY_DSN="" \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PRIVATE_SKIP_SIZE_MINIMIZATION=true \
    NODE_OPTIONS="--max-old-space-size=8192" \
    pnpm run build:frontend 2>&1 | sed 's/^/[frontend-build] /'
    echo "${CONFIG_HASH}" > "${FRONTEND_NEXT}/.config-hash"
    echo "Frontend build complete."
    cd /
fi

# ── Cloudflare proxy bootstrap ───────────────────────────────────────────────
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
    echo "Setting up Cloudflare proxy..."
    python3 /opt/cloudflare-proxy-setup.py 2>&1 || echo "Cloudflare setup failed; continuing without proxy"
fi

_CF_ENV="/tmp/huggingpost-cloudflare-proxy.env"
if [ -f "${_CF_ENV}" ]; then
    # shellcheck source=/dev/null
    . "${_CF_ENV}"
fi

if [ -n "${CLOUDFLARE_PROXY_URL:-}" ] && [ -f /opt/cloudflare-proxy.js ]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --require /opt/cloudflare-proxy.js"
fi

# ── Background HF sync loop ──────────────────────────────────────────────────
SYNC_PID=""
if [ -n "${HF_TOKEN:-}" ]; then
    (
        while true; do
            sleep "$SYNC_INTERVAL"
            python3 /opt/postiz-sync.py sync 2>&1 || true
        done
    ) &
    SYNC_PID=$!
fi

# ── Health server (public port 7860) ─────────────────────────────────────────
node /opt/healthsrv/health-server.js &
HEALTH_PID=$!

if [ -n "${UPTIMEROBOT_API_KEY:-}" ] && [ -n "${SPACE_HOST:-}" ]; then
  echo "Setting up UptimeRobot monitor..."
  bash /opt/setup-uptimerobot.sh "${SPACE_HOST}" || true
fi

sleep 1

# ── Postiz: nginx + PM2 (mirrors upstream CMD `nginx && pnpm run pm2`) ───────
# pm2-run script does: pm2 delete all || true && pnpm run prisma-db-push
#                      && pnpm run --parallel pm2 && pm2 logs
echo "Starting nginx + Postiz PM2 procs..."
cd "${POSTIZ_DIR}"
( nginx && pnpm run pm2 2>&1 | grep -Ev \
    '\[RoutesResolver\]|\[RouterExplorer\]|Mapped \{|\(Use --lines|__/\\\\|_\\/\\\\|PM2 log:|Progress: resolved|[┌┐└┘├┤│─┼]|Runtime Edition|Production Process Manager|built-in Load Balancer|Start and Daemonize|Load Balance|Make pm2 auto-boot|To go further|pm2\.io|pm2 monitor|pm2 startup|pm2 start ' \
  | sed 's/^/[postiz] /' ) &
POSTIZ_PID=$!

echo "Waiting for nginx (port 5000)..."
for i in $(seq 1 90); do
    if curl -sf -m 2 http://127.0.0.1:5000/ >/dev/null 2>&1; then
        echo "Postiz ready (~$((i*2))s)"
        break
    fi
    sleep 2
done

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  HuggingPost is live!                               │"
echo "  │                                                     │"
echo "  │  Dashboard : ${PUBLIC_URL}/"
echo "  │  Postiz    : ${PUBLIC_URL}/app/"
echo "  │                                                     │"
echo "  │  Sign up to create the first admin account.         │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""

# ── Graceful shutdown ────────────────────────────────────────────────────────
cleanup() {
    echo "Shutting down — running final sync..."
    [ -n "${HEALTH_PID:-}" ] && kill "$HEALTH_PID" 2>/dev/null || true
    [ -n "${POSTIZ_PID:-}" ] && kill "$POSTIZ_PID" 2>/dev/null || true
    pm2 kill >/dev/null 2>&1 || true
    nginx -s quit 2>/dev/null || true

    if [ -n "${SYNC_PID:-}" ]; then
        kill "$SYNC_PID" 2>/dev/null || true
        wait "$SYNC_PID" 2>/dev/null || true
    fi

    if [ -n "${HF_TOKEN:-}" ]; then
        python3 /opt/postiz-sync.py sync 2>&1 || true
    fi

    redis-cli -h 127.0.0.1 -p 6379 shutdown nosave 2>/dev/null || true
    su-exec postgres "${PG_BIN}/pg_ctl" -D "${PGDATA}" stop -m fast 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

wait "$POSTIZ_PID"
