---
title: HuggingPost
emoji: 📮
colorFrom: pink
colorTo: indigo
sdk: docker
app_port: 7860
pinned: true
license: agpl-3.0
secrets:
  - name: HF_TOKEN
    description: HF token with WRITE access — enables DB+uploads backup persistence to a private HF Dataset.
  - name: JWT_SECRET
    description: (Optional) Random 48-byte string. Auto-generated on first boot and persisted to backup.
  - name: CLOUDFLARE_WORKERS_TOKEN
    description: (Optional) Cloudflare API token (Workers Scripts → Edit) to auto-provision an outbound proxy.
  - name: RESEND_API_KEY
    description: (Optional) Resend key for sending email activation links. Without it, registration is auto-activated.
  - name: STORAGE_PROVIDER
    description: (Optional) "local" (default) or "cloudflare" to offload media to R2.
  - name: CLOUDFLARE_ACCOUNT_ID
    description: (Optional, if STORAGE_PROVIDER=cloudflare) R2 account ID.
  - name: CLOUDFLARE_ACCESS_KEY
    description: (Optional, if STORAGE_PROVIDER=cloudflare) R2 access key ID.
  - name: CLOUDFLARE_SECRET_ACCESS_KEY
    description: (Optional, if STORAGE_PROVIDER=cloudflare) R2 secret access key.
  - name: CLOUDFLARE_BUCKETNAME
    description: (Optional, if STORAGE_PROVIDER=cloudflare) R2 bucket name.
  - name: CLOUDFLARE_BUCKET_URL
    description: (Optional, if STORAGE_PROVIDER=cloudflare) R2 public bucket URL.
---

[![GitHub Stars](https://img.shields.io/github/stars/somratpro/huggingpost?style=flat-square)](https://github.com/somratpro/huggingpost)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![HF Space](https://img.shields.io/badge/🤗%20HuggingFace-Space-blue?style=flat-square)](https://huggingface.co/spaces/somratpro/HuggingPost)
[![Postiz](https://img.shields.io/badge/Postiz-v2.11.3-ec4899?style=flat-square)](https://github.com/gitroomhq/postiz-app)

**Self-host [Postiz](https://postiz.com) (open-source social-media scheduler — X, LinkedIn, Facebook, Threads, TikTok, YouTube, Pinterest, Reddit, Mastodon, Discord, Slack, and more) on the free Hugging Face Spaces tier.** Persistent across restarts via private HF Dataset backup. No external database, no paid storage required.

## Table of Contents

- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [🔑 Configuration](#-configuration)
- [💾 Backup & Persistence](#-backup--persistence)
- [💓 Keep It Awake](#-keep-it-awake)
- [🌐 Cloudflare Proxy *(Optional)*](#-cloudflare-proxy-optional)
- [🔌 Connecting Social Accounts](#-connecting-social-accounts)
- [🏗️ Architecture](#️-architecture)
- [🐛 Troubleshooting](#-troubleshooting)
- [📚 Links](#-links)

## ✨ Features

- 📅 **30+ Social Platforms** — schedule posts to X, LinkedIn, Facebook, Threads, TikTok, YouTube, Reddit, Mastodon, Discord, Slack, Pinterest, etc.
- ⚡ **One-click deploy** — duplicate the Space, add `HF_TOKEN`, you're done.
- 💾 **Persistent across restarts** — PostgreSQL + uploaded media auto-backed up to a private HF Dataset every 5 min and restored on boot.
- 💓 **Keep-Alive** — built-in dashboard helper to set up an UptimeRobot monitor so scheduled posts actually fire.
- 🌐 **Outbound firewall workaround** — optional Cloudflare Worker proxy auto-provisioned for blocked platform APIs.
- 🔒 **Secrets generated** — `JWT_SECRET` auto-generated on first boot and persisted, no manual setup.
- 🏠 **100% HF-Native** — no external Postgres/Redis/storage accounts needed for the default path.
- 📌 **Pinned to v2.11.3** — last release before Postiz mandated Temporal (which doesn't fit in a single HF container).

## 🚀 Quick Start

### Step 1: Duplicate this Space

[![Duplicate this Space](https://huggingface.co/datasets/huggingface/badges/resolve/main/duplicate-this-space-xl.svg)](https://huggingface.co/spaces/somratpro/HuggingPost?duplicate=true)

### Step 2: Add `HF_TOKEN`

In your new Space's **Settings → Variables and secrets → New secret**:

| Secret | How to get it |
| :--- | :--- |
| `HF_TOKEN` | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) → New token → **Write** access |

> [!WARNING]
> Without `HF_TOKEN`, your data (accounts, scheduled posts, uploaded media) is **lost on every Space restart**. Set this up first.

### Step 3: Wait for the build (~5–8 min first time)

Watch progress in the **Logs** tab. The Postiz build is heavy because it compiles a Next.js frontend + NestJS backend.

### Step 4: Open the Space

Land on the HuggingPost dashboard. Click **Open Postiz →** to reach the login page. **Sign up** to create the first admin account — registration is auto-activated unless you set `RESEND_API_KEY`.

### Step 5: Set Up Keep-Alive (1 min)

On the dashboard, paste your UptimeRobot **Main API key** to create an external monitor that pings `/health` every 5 min. Without this, the Space will sleep and scheduled posts won't fire.

## 🔑 Configuration

### Required

| Variable | Purpose |
| :--- | :--- |
| `HF_TOKEN` | Write-access HF token — enables backup persistence |

### Recommended

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SYNC_INTERVAL` | `300` | Backup interval in seconds (5 min) |
| `BACKUP_DATASET_NAME` | `huggingpost-backup` | Private dataset name (`<user>/<name>`) |
| `RESEND_API_KEY` | — | Required only if you want signup activation emails |

### Storage (Optional — for media offload)

By default, uploaded media (post images/videos) is stored in `/postiz/uploads` inside the container and included in the HF Dataset backup. If your media exceeds ~80 MB total, switch to Cloudflare R2:

| Variable | Purpose |
| :--- | :--- |
| `STORAGE_PROVIDER` | Set to `cloudflare` |
| `CLOUDFLARE_ACCOUNT_ID` | R2 account ID |
| `CLOUDFLARE_ACCESS_KEY` | R2 access key |
| `CLOUDFLARE_SECRET_ACCESS_KEY` | R2 secret |
| `CLOUDFLARE_BUCKETNAME` | R2 bucket name |
| `CLOUDFLARE_BUCKET_URL` | Public R2 URL prefix |

R2 free tier is 10 GB storage + 1M reads/month — plenty for typical use.

### Advanced

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `JWT_SECRET` | auto-generated | If unset, generated and persisted on first boot |
| `SYNC_MAX_FILE_BYTES` | `104857600` (100 MB) | Skip backup if tarball exceeds this size |
| `DISABLE_REGISTRATION` | `false` | Set to `true` after creating your admin account |
| `API_LIMIT` | `30` | Public API hourly rate limit |

## 💾 Backup & Persistence

Every `SYNC_INTERVAL` seconds (default 5 min), HuggingPost:

1. Runs `pg_dump` on the Postiz database.
2. Tars the dump + `/postiz/uploads` + `/postiz/.secrets`.
3. Uploads `snapshots/latest.tar.gz` to your private dataset `<your-username>/huggingpost-backup`.

On boot, the reverse happens — secrets restored first, then DB drop+recreate+replay, then uploads copied back. Your scheduled posts, accounts, and media survive restarts.

**To inspect or download your backup:**

```bash
huggingface-cli download --repo-type dataset <your-username>/huggingpost-backup
```

> [!NOTE]
> The dataset is **private** by default. Don't share its URL publicly — the SQL dump contains your full Postiz state, including encrypted social-media tokens.

## 💓 Keep It Awake

Free HF Spaces sleep after ~48h of no traffic. A sleeping Space cannot fire scheduled posts. The dashboard has a one-time setup form for [UptimeRobot](https://uptimerobot.com) — create a free account, copy your **Main API key** (NOT a Read-only or Monitor-specific key), paste it in the dashboard.

This works for **public** Spaces only. Private Spaces cannot be reached by external monitors.

## 🌐 Cloudflare Proxy *(Optional)*

Hugging Face Spaces sometimes block outbound HTTP to specific social-platform APIs. HuggingPost ships the same transparent Cloudflare Worker proxy used in HuggingClip / HuggingClaw / Hugging8n.

**Auto-setup:**

1. Create a Cloudflare API Token with `Workers Scripts: Edit` permission.
2. Add `CLOUDFLARE_WORKERS_TOKEN` as a Space secret.
3. Restart the Space.

HuggingPost will create or update a Worker named `<your-space-host>-proxy` and route blocked outbound traffic through it transparently. You can scope it with `CLOUDFLARE_PROXY_DOMAINS` (default `*` = all external).

## 🔌 Connecting Social Accounts

Each social platform requires you to register your Postiz instance as an OAuth app. The callback URL pattern is:

```
https://<your-space-host>/api/integrations/social/<platform>/callback
```

For each platform you want (X, LinkedIn, Facebook, etc.), follow the [Postiz provider docs](https://docs.postiz.com/providers) to obtain client ID + secret, then enter them inside Postiz **Settings → Channels** (NOT as Space secrets — Postiz stores them encrypted in its DB).

> [!TIP]
> Some platforms (like X) require a publicly verifiable domain. The HF Space subdomain (`*.hf.space`) works for most but not all platforms. Check each platform's app-creation requirements.

## 🏗️ Architecture

```
HuggingPost/
├── Dockerfile               # Two-stage: build Postiz v2.11.3 → runtime
├── start.sh                 # Orchestrator (Postgres → Redis → restore → procs)
├── health-server.js         # Port 7860: dashboard + reverse proxy split
├── postiz-sync.py           # Backup/restore DB + uploads to HF Dataset
├── cloudflare-proxy.js      # Transparent outbound proxy injected via NODE_OPTIONS
├── cloudflare-proxy-setup.py
├── cloudflare-worker.js
├── setup-uptimerobot.sh
├── docker-compose.yml       # Local dev convenience
├── .env.example             # Configuration reference
└── README.md
```

**Single-port routing** (port 7860, the only port HF Spaces exposes):

| Path | Target | Notes |
| :--- | :--- | :--- |
| `/` | dashboard (local) | HTML status page |
| `/health`, `/status`, `/uptimerobot/setup` | local | JSON / handlers |
| `/api/*` | backend `:3000` | `/api` prefix stripped |
| `/uploads/*` | backend `:3000` | media files |
| `/*` | frontend `:4200` | Next.js pages, `/_next/*`, etc. |

**Internal processes:**

| Process | Port | Memory cap |
| :--- | :--- | :--- |
| `health-server.js` | 7860 (public) | — |
| Postiz frontend (Next.js) | 4200 | 2 GB |
| Postiz backend (NestJS) | 3000 | 2 GB |
| Postiz workers | — | 1 GB |
| Postiz cron | — | 512 MB |
| `postgres` | 5432 | — |
| `redis-server` | 6379 | — |
| `postiz-sync.py` (loop) | — | — |

Total resident set ~3–6 GB under typical load — well within HF free tier's 16 GB.

## 🐛 Troubleshooting

**"Postiz backend unavailable" on first load**
First boot takes 30–90s after the build finishes. Wait for the dashboard to show green badges for both backend and frontend.

**Data lost after restart**
`HF_TOKEN` is not set, or it doesn't have write access. Add it and the next restart will restore from backup. The backup must have run at least once before the restart.

**Backup too large (>100 MB)**
Either move media to Cloudflare R2 (`STORAGE_PROVIDER=cloudflare`) or raise `SYNC_MAX_FILE_BYTES`. The HF Dataset itself supports much larger files, but huge backups slow restart.

**Scheduled posts didn't fire while I was away**
The Space slept. Set up UptimeRobot from the dashboard.

**OAuth callback fails for X/Facebook/LinkedIn**
Some platforms reject `*.hf.space` subdomains as redirect URIs. You may need to put a custom domain in front (Cloudflare → HF Space CNAME).

**Out of memory during build**
The Next.js build needs `--max-old-space-size=4096`. If you forked and changed the Dockerfile, make sure the `NODE_OPTIONS` flag is still on the `pnpm run build` line.

**`prisma-db-push` fails on first boot**
Usually means Postgres didn't finish starting. Container will exit and HF will auto-restart — second boot usually succeeds. If it persists, check Logs for the actual Prisma error.

## 📚 Links

- [Postiz on GitHub](https://github.com/gitroomhq/postiz-app)
- [Postiz docs](https://docs.postiz.com)
- [HuggingFace Spaces docs](https://huggingface.co/docs/hub/spaces)
- Sister projects: [HuggingClip](https://huggingface.co/spaces/somratpro/HuggingClip) (Paperclip), [Hugging8n](https://huggingface.co/spaces/somratpro/Hugging8n) (n8n)

## 📄 License

Wrapper code: MIT. Postiz itself: AGPL-3.0 — see [github.com/gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE) for terms.

*Made with ❤️ by [@somratpro](https://github.com/somratpro)*
