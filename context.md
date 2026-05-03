## HuggingPost — Full Context

**What it is:** Self-hosted Postiz v2.11.3 on Hugging Face Spaces. Social media scheduler with multi-channel posting (8 platforms work immediately, 12+ need OAuth setup).

**Architecture:**

- HF Space: single public port 7860 (health-server.js)
- Internal: nginx:5000 → Postiz 4 PM2 procs (backend:3000, frontend:4200, workers, cron)
- Postgres + Redis internal
- Optional HF Dataset backup + sync loop

---

## Critical Issues Fixed

### 1. **Font build hang** (FIXED)

**Problem:** `next build` tried to fetch fonts from `fonts.gstatic.com` → blocked/throttled on HF → timeout → build never completes → container won't start.

**Solution:** Vendor 4 woff2 files + runtime patch in `start.sh`:

- Fonts: `vendor/fonts/PlusJakartaSans-{500,600}-{normal,italic}.woff2`
- Patch script: `vendor/patch-jakarta-font.js` rewrites two layout.tsx files from `next/font/google` to `next/font/local`
- Dockerfile Stage 2: copies fonts + patch script to `/opt/vendor/`
- start.sh: detects if patch not applied (old cached image), applies it before frontend build

**Commit:** `fd4cae0` (font patch)

### 2. **Blank white page at /app/** (FIXED)

**Root cause:** HF Spaces reverse proxy intercepts absolute redirects to its own hostname, resolves them server-side, returns 200 (not 307). Next.js redirects to `/auth` as `https://somratpro-huggingpost.hf.space/auth` → proxy resolves it → blank 200 page.

**Solution:** Two fixes in health-server.js + Dockerfile:

1. `rewriteLocation()` function converts absolute URLs (internal or SPACE_HOST) to relative `/app` paths so browser does the navigation
2. Nginx patch: fix `proxy_set_header X-Forwarded-Proto` to use HF proxy's value, not internal scheme

**Commits:** `57b8b04` (Location rewrite + nginx fix), `245f89d` (dashboard rewrite)

### 3. **OAuth `client_id=undefined`** (NOT A BUG)

LinkedIn/X/etc. OAuth links show `client_id=undefined` because env vars not set as HF Space secrets. User needs to create developer apps, add keys as secrets, restart. New dashboard guides users through this.

---

## Files Changed

### `Dockerfile`

- Stage 2, after postiz-builder COPY block: copy vendor fonts + patch script to `/opt/vendor/`
- nginx.conf patch:
  - Add `/app` prefix when proxying to Next.js (line 160: `proxy_pass http://127.0.0.1:4200/app/;`)
  - Fix x-forwarded-proto (line 162: use `$http_x_forwarded_proto` not `$scheme`)

### `start.sh`

- Lines 172–187: Runtime font patch block
  - If layout.tsx still has `next/font/google`, copy fonts, run patch script
  - Idempotent — skips if already patched
  - Happens before `next build` so no network calls

### `health-server.js`

- `getSocialPlatforms()` (lines 51–98): Array of all channels with ready status, setup URLs, env var names
  - 8 "works immediately" (Bluesky, Mastodon, Telegram, Dev.to, Hashnode, Nostr, Lemmy, Warpcast)
  - 12 "needs OAuth" (LinkedIn, X, Facebook, Instagram, Threads, YouTube, TikTok, Reddit, Pinterest, Discord, Slack)
- `rewriteLocation()` (lines 465–505): Converts Location headers from Postiz
  - Matches internal hosts (127.0.0.1, localhost) or SPACE_HOST
  - Converts absolute URLs to `/app`-prefixed relative paths
- `renderDashboard()` (lines 176–446): Complete rewrite
  - Open Postiz button (disabled during boot, auto-activates when running)
  - Status badges: Postiz, Uptime, Backup
  - 4-step getting-started guide
  - "Works immediately" section (8 platforms, collapsible)
  - "Needs API keys" section (OAuth platforms, shows count configured, direct links to dev portals)
  - "System & Backup" section (sync status, uptime monitor)
  - Auto-refresh JS every 30s updates button state + badge states
  - Deep-link to HF Space settings using SPACE_ID env var

**Vendor files (new):**

- `vendor/fonts/PlusJakartaSans-500-normal.woff2`, `-500-italic`, `-600-normal`, `-600-italic`
- `vendor/patch-jakarta-font.js`

---

## Current State

✅ **Working:**

- Font patch applied at build time (Dockerfile) + runtime fallback (start.sh)
- Next.js frontend builds successfully (~5 min first boot, <1 min with cached .next from backup)
- Blank `/app/` screen fixed — middleware redirects work, browser navigates correctly
- nginx routes work: /api → backend, /uploads → fs, / → frontend
- Dashboard shows platform status, guides users through setup
- HF_TOKEN secret no longer leaks in startup banner

---

## Deployment

All changes pushed to:

- GitHub: `somratpro/HuggingPost` (main branch)
- HF Space: `somratpro/HuggingPost` (auto-synced)

HF rebuilds automatically when Dockerfile or start.sh changes.
