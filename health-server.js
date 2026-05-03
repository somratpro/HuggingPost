// Single public entrypoint for HF Spaces: HuggingPost dashboard + reverse
// proxy to Postiz (which lives behind the container's internal nginx on
// port 5000 — that nginx routes /api → backend, /uploads → file system,
// / → frontend).
//
// Routing rules (in order):
//   /health, /status, /uptimerobot/setup → handled here
//   / (exact)                            → HuggingPost dashboard HTML
//   /app, /app/ or /app/*               → Postiz (nginx :5000), /app prefix stripped
//   /_next/* or /static/*                → 301 redirect to /app/<same path>
//                                          (catches asset URLs Next.js may emit
//                                           without basePath in edge cases)
//   anything else                        → 404
//
// Why strip /app: the Postiz frontend is built with basePath="/app" so it
// emits asset URLs prefixed with /app. The browser sends /app/_next/foo to
// us; we strip /app and forward /_next/foo to nginx :5000, which forwards
// to Next.js on :4200. nginx's own routes (/api, /uploads, /) are also
// reached after we strip the /app prefix.

const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");

const PORT = 7860;

// Static files in Next.js public/ directory are served directly from disk.
// The nginx proxy chain re-adds the /app basePath prefix when forwarding to
// Next.js:4200, making public file paths misalign. Serving from disk here
// is simpler and faster.
const NEXTJS_PUBLIC_DIR = "/app/apps/frontend/public";
const MIME_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
};
const POSTIZ_HOST = "127.0.0.1";
const POSTIZ_PORT = 5000;

const startTime = Date.now();
const HF_BACKUP_ENABLED = !!process.env.HF_TOKEN;
const SYNC_INTERVAL = process.env.SYNC_INTERVAL || "300";
const UPTIMEROBOT_STATUS_FILE = "/tmp/huggingpost-uptimerobot-status.json";
const UPTIMEROBOT_API_KEY_SET = !!process.env.UPTIMEROBOT_API_KEY;

// Social platform env-var presence check (for dashboard status grid).
// Each entry: { name, emoji, ready: bool, setupUrl, envVars, noOAuth }
function getSocialPlatforms() {
  const e = process.env;
  return [
    // ── Works immediately (connect inside Postiz UI, no env vars needed) ─────
    { name: "Bluesky",    emoji: "🦋", noOAuth: true, ready: true,  note: "Username + App Password in Postiz" },
    { name: "Mastodon",   emoji: "🐘", noOAuth: true, ready: true,  note: "Instance URL + credentials in Postiz" },
    { name: "Telegram",   emoji: "✈️", noOAuth: true, ready: true,  note: "Bot token from @BotFather in Postiz" },
    { name: "Nostr",      emoji: "🔑", noOAuth: true, ready: true,  note: "Private key in Postiz" },
    { name: "Lemmy",      emoji: "🐾", noOAuth: true, ready: true,  note: "Instance + credentials in Postiz" },
    { name: "Warpcast",   emoji: "🟣", noOAuth: true, ready: true,  note: "FID + private key in Postiz" },
    { name: "Dev.to",     emoji: "💻", noOAuth: true, ready: true,  note: "API key from dev.to settings" },
    { name: "Hashnode",   emoji: "📰", noOAuth: true, ready: true,  note: "API token from Hashnode settings" },
    // ── Needs OAuth app (env vars required) ───────────────────────────────────
    { name: "LinkedIn",   emoji: "💼", ready: !!(e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_ID !== "undefined"),
      setupUrl: "https://www.linkedin.com/developers/apps/new",
      envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"] },
    { name: "X / Twitter",emoji: "🐦", ready: !!(e.X_API_KEY),
      setupUrl: "https://developer.twitter.com/en/portal/projects-and-apps",
      envVars: ["X_API_KEY", "X_API_SECRET"] },
    { name: "Facebook",   emoji: "📘", ready: !!(e.FACEBOOK_APP_ID),
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"] },
    { name: "Instagram",  emoji: "📸", ready: !!(e.FACEBOOK_APP_ID),
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
      note: "Uses same app as Facebook" },
    { name: "Threads",    emoji: "🧵", ready: !!(e.THREADS_APP_ID),
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["THREADS_APP_ID", "THREADS_APP_SECRET"] },
    { name: "YouTube",    emoji: "▶️",  ready: !!(e.YOUTUBE_CLIENT_ID),
      setupUrl: "https://console.cloud.google.com/apis/credentials",
      envVars: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"] },
    { name: "TikTok",     emoji: "🎵", ready: !!(e.TIKTOK_CLIENT_ID),
      setupUrl: "https://developers.tiktok.com/",
      envVars: ["TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET"] },
    { name: "Reddit",     emoji: "🤖", ready: !!(e.REDDIT_CLIENT_ID),
      setupUrl: "https://www.reddit.com/prefs/apps",
      envVars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"] },
    { name: "Pinterest",  emoji: "📌", ready: !!(e.PINTEREST_CLIENT_ID),
      setupUrl: "https://developers.pinterest.com/apps/",
      envVars: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"] },
    { name: "Discord",    emoji: "🎮", ready: !!(e.DISCORD_CLIENT_ID),
      setupUrl: "https://discord.com/developers/applications",
      envVars: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN_ID"] },
    { name: "Slack",      emoji: "💬", ready: !!(e.SLACK_ID),
      setupUrl: "https://api.slack.com/apps?new_app=1",
      envVars: ["SLACK_ID", "SLACK_SECRET", "SLACK_SIGNING_SECRET"] },
  ];
}

// ============================================================================
// URL helpers
// ============================================================================

function parseRequestUrl(url) {
  try { return new URL(url, "http://localhost"); }
  catch { return new URL("http://localhost/"); }
}

function isLocalRoute(pathname) {
  return (
    pathname === "/health" ||
    pathname === "/status" ||
    pathname === "/" ||
    pathname === ""
  );
}

// ============================================================================
// UptimeRobot helpers
// ============================================================================

function getUptimeRobotStatus() {
  try {
    if (fs.existsSync(UPTIMEROBOT_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(UPTIMEROBOT_STATUS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

// ============================================================================
// Status helpers
// ============================================================================

function readSyncStatus() {
  try {
    if (fs.existsSync("/tmp/sync-status.json")) {
      return JSON.parse(fs.readFileSync("/tmp/sync-status.json", "utf8"));
    }
  } catch {}
  if (HF_BACKUP_ENABLED) {
    return {
      db_status: "unknown", last_sync_time: null, last_error: null, sync_count: 0,
      status: "configured",
      message: `Backup enabled. Waiting for first sync (every ${SYNC_INTERVAL}s).`,
    };
  }
  return { db_status: "unknown", last_sync_time: null, last_error: null, sync_count: 0 };
}

function checkPostizHealth() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "unreachable", reason: "timeout" }), 5000);
    http.get(`http://${POSTIZ_HOST}:${POSTIZ_PORT}/`, (res) => {
      clearTimeout(timeout);
      resolve({ status: res.statusCode < 500 ? "running" : "error", statusCode: res.statusCode });
      res.resume();
    }).on("error", (err) => {
      clearTimeout(timeout);
      resolve({ status: "unreachable", reason: err.message });
    });
  });
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ============================================================================
// Dashboard HTML
// ============================================================================

function renderDashboard(initialData) {
  const syncStatus = initialData.sync;
  const hasBackup = HF_BACKUP_ENABLED;
  const lastSync = syncStatus.last_sync_time ? new Date(syncStatus.last_sync_time).toLocaleString() : "Never";
  const syncError = syncStatus.last_error || null;
  const platforms = getSocialPlatforms();
  const readyNow = platforms.filter(p => p.noOAuth);
  const needsSetup = platforms.filter(p => !p.noOAuth);
  const configuredCount = needsSetup.filter(p => p.ready).length;

  const syncBadge = !hasBackup
    ? `<span class="badge badge-off">Disabled</span>`
    : syncError
    ? `<span class="badge badge-err">Error</span>`
    : syncStatus.last_sync_time
    ? `<span class="badge badge-on"><i class="dot"></i>Syncing</span>`
    : `<span class="badge badge-wait"><i class="dot" style="background:#3b82f6"></i>Pending</span>`;

  const postizBadge = initialData.postizRunning
    ? `<span class="badge badge-on"><i class="dot"></i>Running</span>`
    : `<span class="badge badge-off">Booting…</span>`;

  const needsSetupRows = needsSetup.map(p => {
    if (p.ready) {
      return `<div class="plat-row ready">
        <span class="plat-icon">${p.emoji}</span>
        <span class="plat-name">${p.name}</span>
        <span class="badge badge-on" style="font-size:0.72rem">Configured</span>
      </div>`;
    }
    return `<div class="plat-row">
      <span class="plat-icon" style="filter:grayscale(1);opacity:.5">${p.emoji}</span>
      <span class="plat-name" style="color:var(--dim)">${p.name}</span>
      <a class="setup-link" href="${p.setupUrl}" target="_blank" rel="noopener">Get API keys →</a>
    </div>`;
  }).join("");

  const readyNowRows = readyNow.map(p => `
    <div class="plat-row ready">
      <span class="plat-icon">${p.emoji}</span>
      <span class="plat-name">${p.name}</span>
      <span style="font-size:0.75rem;color:var(--dim)">${p.note || ""}</span>
    </div>`).join("");

  const uptimerobotStatus = getUptimeRobotStatus();
  let keepAwakeNote;
  if (uptimerobotStatus?.configured) {
    keepAwakeNote = `<span class="badge badge-on" style="font-size:0.72rem"><i class="dot"></i>Monitor active</span>`;
  } else if (UPTIMEROBOT_API_KEY_SET) {
    keepAwakeNote = `<span class="badge badge-wait" style="font-size:0.72rem"><i class="dot" style="background:#3b82f6"></i>Setting up…</span>`;
  } else {
    keepAwakeNote = `<span style="color:var(--dim);font-size:0.8rem">Add <code>UPTIMEROBOT_API_KEY</code> secret to keep Space awake 24/7</span>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HuggingPost Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f172a;--card:rgba(30,41,59,.75);--accent:linear-gradient(135deg,#ec4899,#8b5cf6);--text:#f8fafc;--dim:#94a3b8;--ok:#10b981;--err:#ef4444}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Outfit',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:24px 12px;
  background-image:radial-gradient(at 0% 0%,rgba(236,72,153,.15) 0,transparent 50%),radial-gradient(at 100% 0%,rgba(139,92,246,.15) 0,transparent 50%)}
.wrap{max-width:640px;margin:0 auto}
.card{background:var(--card);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:24px;margin-bottom:16px;
  backdrop-filter:blur(12px);animation:up .5s ease}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
header{text-align:center;margin-bottom:24px}
h1{font-size:2.2rem;font-weight:600;background:var(--accent);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:var(--dim);font-size:.85rem;letter-spacing:1px;text-transform:uppercase;margin-top:4px}
h2{font-size:.75rem;text-transform:uppercase;color:var(--dim);letter-spacing:.08em;margin-bottom:14px}
.open-btn{display:block;text-align:center;background:var(--accent);color:#fff;font-family:inherit;font-size:1rem;
  font-weight:600;padding:16px;border-radius:14px;text-decoration:none;margin-bottom:16px;
  box-shadow:0 8px 24px -6px rgba(236,72,153,.45);transition:transform .2s,box-shadow .2s}
.open-btn:hover{transform:scale(1.02);box-shadow:0 12px 30px -6px rgba(236,72,153,.6)}
.open-btn.booting{background:rgba(255,255,255,.07);color:var(--dim);box-shadow:none;cursor:wait}
.status-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.stat{flex:1;min-width:120px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);
  border-radius:14px;padding:14px 16px}
.stat-label{font-size:.7rem;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.stat-val{font-size:.95rem;font-weight:600}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:.78rem;font-weight:600}
.badge-on{background:rgba(16,185,129,.12);color:var(--ok)}
.badge-off{background:rgba(239,68,68,.12);color:var(--err)}
.badge-wait{background:rgba(59,130,246,.12);color:#3b82f6}
.badge-err{background:rgba(239,68,68,.12);color:var(--err)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 2s infinite;flex-shrink:0}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.7)}70%{box-shadow:0 0 0 8px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}
.steps{counter-reset:step;list-style:none;padding:0}
.steps li{counter-increment:step;display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.steps li:last-child{border-bottom:none}
.steps li::before{content:counter(step);min-width:24px;height:24px;border-radius:50%;background:var(--accent);
  color:#fff;font-size:.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
.steps li .s-title{font-size:.9rem;font-weight:600;margin-bottom:2px}
.steps li .s-note{font-size:.8rem;color:var(--dim);line-height:1.5}
.steps li a{color:#f472b6;text-decoration:none}
.steps li a:hover{text-decoration:underline}
.section-toggle{width:100%;background:none;border:none;color:var(--text);font:inherit;font-size:.75rem;
  text-transform:uppercase;letter-spacing:.08em;color:var(--dim);display:flex;align-items:center;
  justify-content:space-between;cursor:pointer;padding:0;margin-bottom:14px}
.section-toggle svg{transition:transform .2s}
.section-toggle.open svg{transform:rotate(180deg)}
.collapse{display:none}.collapse.open{display:block}
.plat-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.88rem}
.plat-row:last-child{border-bottom:none}
.plat-icon{font-size:1.1rem;width:24px;text-align:center;flex-shrink:0}
.plat-name{flex:1;font-weight:500}
.setup-link{color:#f472b6;font-size:.78rem;text-decoration:none;flex-shrink:0}
.setup-link:hover{text-decoration:underline}
.sync-note{font-size:.8rem;color:var(--dim);margin-top:8px}
code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.85em}
.footer{text-align:center;color:var(--dim);font-size:.75rem;margin-top:8px;padding-bottom:24px}
@media(max-width:500px){h1{font-size:1.8rem}.status-row{gap:8px}.stat{padding:12px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📮 HuggingPost</h1>
    <p class="sub">Self-hosted Postiz · Hugging Face Spaces</p>
  </header>

  <!-- Open Postiz button -->
  ${initialData.postizRunning
    ? `<a href="/app/" class="open-btn" target="_blank" rel="noopener">Open Postiz →</a>`
    : `<a href="#" class="open-btn booting" onclick="return false">⏳ Postiz is starting up (first boot ~5 min)…</a>`}

  <!-- Status row -->
  <div class="status-row">
    <div class="stat"><div class="stat-label">Postiz</div><div class="stat-val" id="postiz-badge">${postizBadge}</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">${formatUptime(Math.floor((Date.now() - startTime) / 1000))}</div></div>
    <div class="stat"><div class="stat-label">Backup</div><div class="stat-val" id="sync-badge">${syncBadge}</div></div>
  </div>

  <!-- Getting Started -->
  <div class="card">
    <h2>🚀 Getting Started</h2>
    <ol class="steps">
      <li>
        <div>
          <div class="s-title">Create your account</div>
          <div class="s-note">Click <strong>Open Postiz</strong> above. The first signup becomes the admin account.</div>
        </div>
      </li>
      <li>
        <div>
          <div class="s-title">Connect social accounts that work immediately</div>
          <div class="s-note">Bluesky, Mastodon, Telegram, Dev.to, Hashnode and more connect with just your username — no developer setup needed. See the list below.</div>
        </div>
      </li>
      <li>
        <div>
          <div class="s-title">Enable LinkedIn, X, YouTube… (optional)</div>
          <div class="s-note">These require a free API key from each platform. Go to the platform's developer portal, create an app, then add the keys as <a href="https://huggingface.co/spaces/${process.env.SPACE_ID || "your-space"}/settings" target="_blank">Space secrets</a>. See the platform list below for direct links.</div>
        </div>
      </li>
      <li>
        <div>
          <div class="s-title">Keep your Space awake (optional)</div>
          <div class="s-note">HF Spaces sleep after inactivity — scheduled posts won't fire while sleeping. Add <code>UPTIMEROBOT_API_KEY</code> to auto-create a free uptime monitor, or upgrade to a paid HF Space.</div>
        </div>
      </li>
    </ol>
  </div>

  <!-- Platforms ready now -->
  <div class="card">
    <button class="section-toggle open" onclick="toggle(this,'ready-list')">
      ✅ Works immediately — no API keys needed (${readyNow.length} platforms)
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="ready-list" class="collapse open">
      ${readyNowRows}
      <div class="sync-note" style="margin-top:10px">Connect these inside Postiz → <strong>Add Channel</strong> after signing in.</div>
    </div>
  </div>

  <!-- Platforms needing setup -->
  <div class="card">
    <button class="section-toggle open" onclick="toggle(this,'oauth-list')">
      🔑 Needs API keys — ${configuredCount}/${needsSetup.length} configured
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="oauth-list" class="collapse open">
      ${needsSetupRows}
      <div class="sync-note" style="margin-top:10px">
        After getting API keys: go to your <a href="https://huggingface.co/spaces/${process.env.SPACE_ID || "your-space"}/settings" target="_blank" style="color:#f472b6">Space Settings → Variables & Secrets</a>, add the keys, then restart the Space.
      </div>
    </div>
  </div>

  <!-- Backup & System -->
  <div class="card">
    <button class="section-toggle" onclick="toggle(this,'sys-detail')">
      ⚙️ System &amp; Backup
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="sys-detail" class="collapse">
      <div class="plat-row">
        <span style="flex:1;font-size:.85rem">Database backup to HF Dataset</span>
        <span id="sync-badge-detail">${syncBadge}</span>
      </div>
      <div class="plat-row">
        <span style="flex:1;font-size:.85rem">Last sync</span>
        <span style="font-size:.82rem;color:var(--dim)" id="sync-time-detail">${lastSync}</span>
      </div>
      <div class="plat-row">
        <span style="flex:1;font-size:.85rem">Keep-awake monitor</span>
        ${keepAwakeNote}
      </div>
      <div class="sync-note" id="sync-msg">${syncError ? "Backup error: " + syncError : syncStatus.last_sync_time ? "Last backup successful" : hasBackup ? "Waiting for first sync…" : "Add HF_TOKEN secret to enable automatic DB backups"}</div>
    </div>
  </div>

  <div class="footer">Auto-refreshes every 30s · <a href="/health" style="color:var(--dim);text-decoration:none">Health endpoint</a></div>
</div>

<script>
function toggle(btn, id) {
  btn.classList.toggle('open');
  document.getElementById(id).classList.toggle('open');
}

function renderSyncBadge(hasBackup, lastSyncTime, lastError) {
  if (!hasBackup) return '<span class="badge badge-off">Disabled</span>';
  if (lastError) return '<span class="badge badge-err">Error</span>';
  if (lastSyncTime) return '<span class="badge badge-on"><i class="dot"></i>Syncing</span>';
  return '<span class="badge badge-wait"><i class="dot" style="background:#3b82f6"></i>Pending</span>';
}

async function refresh() {
  try {
    const d = await fetch('/status').then(r => r.json());
    document.getElementById('uptime').textContent = d.uptime;

    const running = d.postizRunning;
    document.getElementById('postiz-badge').innerHTML = running
      ? '<span class="badge badge-on"><i class="dot"></i>Running</span>'
      : '<span class="badge badge-off">Booting…</span>';

    const btn = document.querySelector('.open-btn');
    if (btn && running && btn.classList.contains('booting')) {
      btn.classList.remove('booting');
      btn.textContent = 'Open Postiz →';
      btn.href = '/app/';
      btn.onclick = null;
    }

    const badge = renderSyncBadge(${hasBackup}, d.sync.last_sync_time, d.sync.last_error);
    ['sync-badge','sync-badge-detail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = badge;
    });
    const ls = d.sync.last_sync_time ? new Date(d.sync.last_sync_time).toLocaleString() : 'Never';
    const el = document.getElementById('sync-time-detail');
    if (el) el.textContent = ls;
    const msg = document.getElementById('sync-msg');
    if (msg) msg.textContent = d.sync.last_error ? 'Backup error: ' + d.sync.last_error
      : d.sync.last_sync_time ? 'Last backup successful'
      : ${hasBackup} ? 'Waiting for first sync…' : 'Add HF_TOKEN secret to enable automatic DB backups';
  } catch(e) {}
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

// ============================================================================
// Reverse proxy
// ============================================================================

function buildProxyHeaders(headers) {
  const f = headers["x-forwarded-for"];
  const clientIp = typeof f === "string" ? f.split(",")[0].trim()
    : (Array.isArray(f) && f.length ? String(f[0]).split(",")[0].trim() : "");
  return {
    ...headers,
    host: `${POSTIZ_HOST}:${POSTIZ_PORT}`,
    "x-forwarded-for": clientIp,
    "x-forwarded-host": headers.host || "",
    "x-forwarded-proto": headers["x-forwarded-proto"] || "https",
  };
}

function rewriteLocation(loc) {
  // Postiz's Next.js middleware redirects without the basePath prefix (/app)
  // and may use an internal hostname (127.0.0.1:NGINX_PORT) or the public
  // HF Space hostname (SPACE_HOST). The HF Spaces reverse proxy intercepts
  // absolute redirects to its own hostname — it resolves them server-side
  // and returns 200 at the original URL (blank white page for the client).
  //
  // Normalise every Location header from the Postiz nginx proxy:
  //   1. If it's an absolute URL to an internal or own-Space host → extract path.
  //   2. If the resulting path doesn't start with /app → prepend /app.
  //
  // This converts absolute redirects to relative ones so the browser
  // (not HF proxy) navigates and the URL bar updates correctly.
  //
  // Examples:
  //   http://127.0.0.1:5000/auth/login              → /app/auth/login
  //   https://somratpro-huggingpost.hf.space/auth   → /app/auth
  //   /auth/login                                    → /app/auth/login
  //   /app/auth/login                                → /app/auth/login (unchanged)
  //   https://twitter.com/oauth/...                  → unchanged (external)
  if (!loc) return loc;
  const spaceHost = process.env.SPACE_HOST || null; // e.g. somratpro-huggingpost.hf.space
  let path = null;
  if (loc.startsWith("/")) {
    path = loc;
  } else {
    try {
      const u = new URL(loc);
      if (
        /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.host) ||
        (spaceHost && u.hostname === spaceHost)
      ) {
        path = u.pathname + u.search + u.hash;
      }
    } catch {}
  }
  if (path !== null && !path.startsWith("/app/") && path !== "/app") {
    return "/app" + path;
  }
  return loc;
}

function proxyHttp(req, res, overridePath) {
  const targetPath = overridePath !== undefined ? overridePath : req.url;
  let upstreamStarted = false;
  const proxyReq = http.request(
    { hostname: POSTIZ_HOST, port: POSTIZ_PORT, method: req.method,
      path: targetPath, headers: buildProxyHeaders(req.headers) },
    (proxyRes) => {
      upstreamStarted = true;
      // Rewrite Location headers: add /app basePath if missing, convert
      // internal-host absolute URLs to relative paths.
      const outHeaders = Object.assign({}, proxyRes.headers);
      const fixedLoc = rewriteLocation(outHeaders["location"]);
      if (fixedLoc !== outHeaders["location"]) outHeaders["location"] = fixedLoc;
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    if (res.headersSent || upstreamStarted) { res.destroy(); return; }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "error",
      message: "Postiz unavailable",
      detail: error.message,
      hint: "Postiz may still be starting (first boot ~60s after build). Check the Logs tab.",
    }));
  });
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, overridePath) {
  const targetPath = overridePath !== undefined ? overridePath : req.url;
  const proxySocket = net.connect(POSTIZ_PORT, POSTIZ_HOST);
  proxySocket.on("connect", () => {
    const f = req.headers["x-forwarded-for"];
    const clientIp = typeof f === "string" ? f.split(",")[0].trim() : req.socket.remoteAddress || "";
    const headerLines = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      const lower = String(name).toLowerCase();
      if (lower === "host" || lower.startsWith("x-forwarded-")) continue;
      headerLines.push(`${name}: ${value}`);
    }
    const lines = [
      `${req.method} ${targetPath} HTTP/${req.httpVersion}`,
      ...headerLines,
      `Host: ${POSTIZ_HOST}:${POSTIZ_PORT}`,
      `X-Forwarded-For: ${clientIp}`,
      `X-Forwarded-Host: ${req.headers.host || ""}`,
      `X-Forwarded-Proto: ${req.headers["x-forwarded-proto"] || "https"}`,
      "", "",
    ];
    proxySocket.write(lines.join("\r\n"));
    if (head && head.length > 0) proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });
  proxySocket.on("error", () => {
    if (socket.writable) socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  socket.on("error", () => proxySocket.destroy());
}

// ============================================================================
// HTTP Server
// ============================================================================

const server = http.createServer((req, res) => {
  const parsedUrl = parseRequestUrl(req.url || "/");
  const pathname = parsedUrl.pathname;
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  // ── /health ──────────────────────────────────────────────────────────────
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", uptime, uptimeHuman: formatUptime(uptime),
      timestamp: new Date().toISOString(), sync: readSyncStatus(),
    }));
    return;
  }

  // ── /status ──────────────────────────────────────────────────────────────
  if (pathname === "/status") {
    void (async () => {
      const postiz = await checkPostizHealth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        uptime: formatUptime(uptime),
        postizRunning: postiz.status === "running",
        sync: readSyncStatus(),
      }));
    })();
    return;
  }

  // ── Dashboard at exact / ─────────────────────────────────────────────────
  if (pathname === "/" || pathname === "") {
    void (async () => {
      const postiz = await checkPostizHealth();
      const initialData = {
        postizRunning: postiz.status === "running",
        sync: readSyncStatus(),
      };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard(initialData));
    })();
    return;
  }

  // ── /app, /app/ and /app/* → proxy to nginx (Next.js handles routing) ────
  // Do NOT short-circuit /app/ to /app/auth/ here — Next.js middleware does
  // the right thing: auth cookie present → /launches, absent → /auth/.
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const stripped = pathname.slice("/app".length) || "/";
    const query = parsedUrl.search || "";

    // Static files in Next.js public/ land here with /app/ prefix (basePath).
    // Serve them directly from disk instead of proxying through nginx so the
    // path mismatch introduced by the nginx /app/ re-add patch doesn't matter.
    // _next/ bundles are NOT in public/ — skip them and proxy normally.
    const ext = path.extname(stripped).toLowerCase();
    if (ext && !stripped.startsWith("/_next/") && MIME_TYPES[ext]) {
      const absPath = path.resolve(NEXTJS_PUBLIC_DIR, "." + stripped);
      if (absPath.startsWith(NEXTJS_PUBLIC_DIR + path.sep)) {
        const stream = fs.createReadStream(absPath);
        stream.once("open", () => {
          res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext],
            "Cache-Control": "public, max-age=86400",
          });
          stream.pipe(res);
        });
        stream.once("error", () => {
          // File not in public/ — fall through to nginx proxy.
          if (!res.headersSent) proxyHttp(req, res, stripped + query);
          else res.destroy();
        });
        return;
      }
    }

    proxyHttp(req, res, stripped + query);
    return;
  }

  // ── Stray asset URLs without basePath (Sentry, hardcoded /static) ────────
  // Browser-side libs sometimes emit absolute URLs that bypass Next.js
  // basePath. Catch /_next/* and /static/* at root and 301 to /app/* so the
  // browser learns the right prefix.
  if (pathname.startsWith("/_next/") || pathname.startsWith("/static/")) {
    res.writeHead(301, { Location: "/app" + pathname + (parsedUrl.search || "") });
    res.end();
    return;
  }

  // ── Anything else → redirect to /app<path> ──────────────────────────────
  // After login, Postiz's client-side router may navigate to a path without
  // the /app basePath prefix (e.g. /launches, /analytics, /api/...).
  // Redirect those here rather than 404-ing so the browser lands correctly.
  res.writeHead(302, { Location: "/app" + pathname + (parsedUrl.search || "") });
  res.end();
});

server.on("upgrade", (req, socket, head) => {
  const parsedUrl = parseRequestUrl(req.url || "/");
  const pathname = parsedUrl.pathname;
  if (isLocalRoute(pathname)) { socket.destroy(); return; }
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const stripped = pathname.slice("/app".length) || "/";
    proxyUpgrade(req, socket, head, stripped + (parsedUrl.search || ""));
    return;
  }
  socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Health server listening on port ${PORT}`);
  console.log(`✓ Dashboard : http://localhost:${PORT}/`);
  console.log(`✓ Postiz    : http://localhost:${PORT}/app/  → nginx :${POSTIZ_PORT}`);
});
