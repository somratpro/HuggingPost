// Single public entrypoint for HF Spaces: HuggingPost dashboard + reverse
// proxy to Postiz (which lives behind the container's internal nginx on
// port 5000 — that nginx routes /api → backend, /uploads → file system,
// / → frontend).
//
// Routing rules (in order):
//   /health, /status, /uptimerobot/setup → handled here
//   / (exact)                            → HuggingPost dashboard HTML
//   /app or /app/*                       → Postiz (nginx :5000), /app prefix stripped
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
  const uptimerobotStatus = getUptimeRobotStatus();
  let keepAwakeHtml;
  if (uptimerobotStatus?.configured) {
    keepAwakeHtml = `<div class="helper-summary success">
      <span class="status-badge status-online"><div class="pulse"></div>Configured</span>
      <span>UptimeRobot monitor active for <code>${uptimerobotStatus.url || "your /health endpoint"}</code>.</span>
    </div>`;
  } else if (uptimerobotStatus?.configured === false) {
    keepAwakeHtml = `<div class="helper-summary error">
      <span class="status-badge status-error">Failed</span>
      <span>Monitor setup failed. Check Space logs.</span>
    </div>`;
  } else if (UPTIMEROBOT_API_KEY_SET) {
    keepAwakeHtml = `<div class="helper-summary"><span class="status-badge status-syncing"><div class="pulse" style="background:#3b82f6"></div>Setting up</span> Setting up UptimeRobot monitor...</div>`;
  } else {
    keepAwakeHtml = `<div class="helper-summary">
      <strong>Not configured.</strong> Add <code>UPTIMEROBOT_API_KEY</code> to Space secrets to enable keep-awake monitoring.
    </div>`;
  }

  const syncStatus = initialData.sync;
  const hasBackup = HF_BACKUP_ENABLED;
  const lastSync = syncStatus.last_sync_time ? new Date(syncStatus.last_sync_time).toLocaleString() : "Never";
  const syncError = syncStatus.last_error || null;

  const syncBadge = !hasBackup
    ? `<div class="status-badge status-offline">Disabled</div>`
    : syncError
    ? `<div class="status-badge status-error">Error</div>`
    : syncStatus.last_sync_time
    ? `<div class="status-badge status-online"><div class="pulse"></div>Enabled</div>`
    : `<div class="status-badge status-syncing"><div class="pulse" style="background:#3b82f6"></div>Pending</div>`;

  const postizBadge = initialData.postizRunning
    ? `<div class="status-badge status-online"><div class="pulse"></div>Running</div>`
    : `<div class="status-badge status-offline">Booting</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HuggingPost Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --accent: linear-gradient(135deg, #ec4899, #8b5cf6);
            --text: #f8fafc;
            --text-dim: #94a3b8;
            --success: #10b981;
            --error: #ef4444;
            --warning: #f59e0b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg);
            color: var(--text);
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
            padding: 24px 0;
            background-image:
                radial-gradient(at 0% 0%, rgba(236, 72, 153, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(139, 92, 246, 0.15) 0px, transparent 50%);
        }
        .dashboard {
            width: 90%; max-width: 600px;
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 24px; padding: 40px;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
            animation: fadeIn 0.8s ease-out;
            margin: 24px 0;
        }
        @keyframes fadeIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        header { text-align: center; margin-bottom: 40px; }
        h1 {
            font-size: 2.5rem; margin-bottom: 8px;
            background: var(--accent);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-weight: 600;
        }
        .subtitle { color: var(--text-dim); font-size: 0.9rem; letter-spacing: 1px; text-transform: uppercase; }
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .stat-card {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.05);
            padding: 20px; border-radius: 16px;
            transition: transform 0.3s ease, border-color 0.3s ease;
        }
        .stat-card:hover { transform: translateY(-3px); border-color: rgba(236,72,153,0.3); }
        .stat-label { color: var(--text-dim); font-size: 0.75rem; text-transform: uppercase; margin-bottom: 8px; display: block; }
        .stat-value { font-size: 1.1rem; font-weight: 600; }
        .stat-btn {
            grid-column: span 2;
            background: var(--accent);
            color: #fff; padding: 16px;
            border-radius: 16px; text-align: center;
            text-decoration: none; font-weight: 600;
            display: block;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            box-shadow: 0 10px 20px -5px rgba(236,72,153,0.4);
        }
        .stat-btn:hover { transform: scale(1.02); box-shadow: 0 15px 30px -5px rgba(236,72,153,0.6); }
        .status-badge {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 4px 12px; border-radius: 20px;
            font-size: 0.8rem; font-weight: 600;
        }
        .status-online  { background: rgba(16,185,129,0.1); color: var(--success); }
        .status-offline { background: rgba(239,68,68,0.1); color: var(--error); }
        .status-syncing { background: rgba(59,130,246,0.1); color: #3b82f6; }
        .status-error   { background: rgba(239,68,68,0.1); color: var(--error); }
        .pulse {
            width: 8px; height: 8px; border-radius: 50%;
            background: currentColor;
            box-shadow: 0 0 0 0 rgba(16,185,129,0.7);
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%   { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16,185,129,0.7); }
            70%  { transform: scale(1);    box-shadow: 0 0 0 10px rgba(16,185,129,0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }
        .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .card-header .stat-label { margin-bottom: 0; }
        .sync-info { background: rgba(255,255,255,0.02); padding: 15px; border-radius: 12px; font-size: 0.85rem; color: var(--text-dim); margin-top: 10px; }
        #sync-msg { color: var(--text); display: block; margin-top: 4px; }
        .helper-card { width: 100%; margin-top: 20px; }
        .helper-copy { color: var(--text-dim); font-size: 0.92rem; line-height: 1.6; margin-top: 10px; }
        .helper-copy strong { color: var(--text); }
        .helper-row { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
        .helper-input {
            flex: 1; min-width: 240px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            color: var(--text); border-radius: 12px;
            padding: 14px 16px; font: inherit;
        }
        .helper-input::placeholder { color: var(--text-dim); }
        .helper-button {
            background: var(--accent); color: #fff; border: 0;
            border-radius: 12px; padding: 14px 18px;
            font: inherit; font-weight: 600; cursor: pointer; min-width: 180px;
        }
        .helper-button:disabled { opacity: 0.6; cursor: wait; }
        .hidden { display: none !important; }
        .helper-note { margin-top: 10px; font-size: 0.82rem; color: var(--text-dim); }
        .helper-result { margin-top: 14px; padding: 12px 14px; border-radius: 12px; font-size: 0.9rem; display: none; }
        .helper-result.ok    { display: block; background: rgba(16,185,129,0.1); color: var(--success); }
        .helper-result.error { display: block; background: rgba(239,68,68,0.1); color: var(--error); }
        .helper-shell { margin-top: 12px; }
        .helper-shell.hidden { display: none; }
        .helper-summary {
            margin-top: 14px; padding: 12px 14px; border-radius: 12px;
            background: rgba(255,255,255,0.03); color: var(--text-dim);
            font-size: 0.9rem; line-height: 1.5;
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        }
        .helper-summary strong { color: var(--text); }
        .helper-summary code { background: rgba(255,255,255,0.07); padding: 1px 6px; border-radius: 4px; font-size: 0.85em; color: var(--text); }
        .helper-summary.success { background: rgba(16,185,129,0.08); }
        .helper-summary.error { background: rgba(239,68,68,0.08); }
        .footer { text-align: center; color: var(--text-dim); font-size: 0.8rem; margin-top: 20px; }
        @media (max-width: 700px) {
            body { padding: 16px 0; }
            .dashboard { width: calc(100% - 24px); padding: 24px; border-radius: 18px; margin: 12px 0; }
            header { margin-bottom: 28px; }
            h1 { font-size: 2rem; }
            .stats-grid { grid-template-columns: 1fr; gap: 14px; margin-bottom: 16px; }
            .stat-btn { grid-column: span 1; }
            .helper-row { flex-direction: column; }
            .helper-input, .helper-button { width: 100%; min-width: 0; }
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <header>
            <h1>📮 HuggingPost</h1>
            <p class="subtitle">Postiz on HF Spaces</p>
        </header>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="card-header">
                    <span class="stat-label">Postiz</span>
                    <span id="postiz-badge">${postizBadge}</span>
                </div>
                <div style="margin-top: 8px; font-size: 0.82rem; color: var(--text-dim);">
                    Mounted at <strong style="color:var(--text)">/app</strong> · <a href="/app/" style="color:#f472b6;text-decoration:none;" target="_blank">Open UI →</a>
                </div>
            </div>
            <div class="stat-card">
                <span class="stat-label">Uptime</span>
                <span class="stat-value" id="uptime">${formatUptime(Math.floor((Date.now() - startTime) / 1000))}</span>
            </div>
            <div class="stat-card">
                <div class="card-header">
                    <span class="stat-label">Backup</span>
                    <span id="sync-badge">${syncBadge}</span>
                </div>
                <div style="margin-top: 8px; font-size: 0.82rem; color: var(--text-dim);">
                    Last sync: <span id="last-sync">${lastSync}</span>
                </div>
            </div>
            <div class="stat-card">
                <span class="stat-label">Database</span>
                <span class="stat-value" id="db-status">${syncStatus.db_status === "connected" ? "PostgreSQL ✓" : syncStatus.db_status === "error" ? "Error" : "PostgreSQL"}</span>
            </div>
            <a href="/app/" id="open-ui-btn" class="stat-btn" target="_blank" rel="noopener noreferrer">Open Postiz →</a>
        </div>

        <div class="stat-card" style="width: 100%; margin-bottom: 20px;">
            <div class="card-header">
                <span class="stat-label">Backup Sync</span>
                <div id="sync-badge-detail">${syncBadge}</div>
            </div>
            <div class="sync-info">
                Last activity: <span id="sync-time-detail">${lastSync}</span>
                <span id="sync-msg">${syncError ? "Error: " + syncError : syncStatus.last_sync_time ? "Sync successful" : hasBackup ? "Waiting for first sync..." : "HF_TOKEN not set — backups disabled"}</span>
            </div>
        </div>

        <div class="stat-card helper-card">
            <span class="stat-label">Keep Space Awake</span>
            ${keepAwakeHtml}
        </div>

        <div class="footer">Live updates every 30s · Schedule posts only fire while the Space is awake</div>
    </div>

    <script>
        function getCurrentSearch() { return window.location.search || ''; }

        function renderSyncBadge(status, lastSyncTime, lastError) {
            if (!${hasBackup}) return '<div class="status-badge status-offline">Disabled</div>';
            if (lastError) return '<div class="status-badge status-error">Error</div>';
            if (lastSyncTime) return '<div class="status-badge status-online"><div class="pulse"></div>Enabled</div>';
            return '<div class="status-badge status-syncing"><div class="pulse" style="background:#3b82f6"></div>Pending</div>';
        }

        async function updateStatus() {
            try {
                const res = await fetch('/status' + getCurrentSearch());
                const data = await res.json();
                document.getElementById('uptime').textContent = data.uptime;

                const pbadge = data.postizRunning
                    ? '<div class="status-badge status-online"><div class="pulse"></div>Running</div>'
                    : '<div class="status-badge status-offline">Booting</div>';
                document.getElementById('postiz-badge').innerHTML = pbadge;

                const badge = renderSyncBadge(data.sync.db_status, data.sync.last_sync_time, data.sync.last_error);
                document.getElementById('sync-badge').innerHTML = badge;
                document.getElementById('sync-badge-detail').innerHTML = badge;

                const lastSync = data.sync.last_sync_time ? new Date(data.sync.last_sync_time).toLocaleString() : 'Never';
                document.getElementById('last-sync').textContent = lastSync;
                document.getElementById('sync-time-detail').textContent = lastSync;

                const syncMsg = data.sync.last_error ? 'Error: ' + data.sync.last_error
                    : data.sync.last_sync_time ? 'Sync successful'
                    : ${hasBackup} ? 'Waiting for first sync...' : 'HF_TOKEN not set — backups disabled';
                document.getElementById('sync-msg').textContent = syncMsg;

                const dbEl = document.getElementById('db-status');
                dbEl.textContent = data.sync.db_status === 'connected' ? 'PostgreSQL ✓'
                    : data.sync.db_status === 'error' ? 'Error' : 'PostgreSQL';
            } catch (e) { console.error('Status update failed:', e); }
        }

        updateStatus();
        setInterval(updateStatus, 30000);
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
  // and may use an internal hostname (127.0.0.1:NGINX_PORT) that HF Spaces'
  // reverse proxy blocks (returning 200 empty body instead of the redirect).
  //
  // Normalise every Location header from the Postiz nginx proxy:
  //   1. If it's an absolute URL to an internal host → extract the path.
  //   2. If the resulting path doesn't start with /app → prepend /app.
  //
  // Examples:
  //   http://127.0.0.1:5000/auth/login  → /app/auth/login
  //   http://localhost:4200/auth         → /app/auth
  //   /auth/login                        → /app/auth/login
  //   /app/auth/login                    → /app/auth/login  (unchanged)
  //   https://twitter.com/oauth/...      → unchanged (external host)
  if (!loc) return loc;
  let path = null;
  if (loc.startsWith("/")) {
    path = loc;
  } else {
    try {
      const u = new URL(loc);
      if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.host)) {
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

  // ── /app (exact root) → redirect to /app/auth/ ───────────────────────────
  // nginx:5000's location / proxies to Next.js as GET /app/ but Next.js
  // returns an empty 200 for the bare root — middleware redirect never fires.
  // Short-circuit at this layer: send the browser straight to /app/auth/;
  // Next.js middleware will redirect to /app/launches/ if already logged in.
  if (pathname === "/app" || pathname === "/app/") {
    res.writeHead(302, { Location: "/app/auth/" });
    res.end();
    return;
  }

  // ── /app/* → serve public static files from disk, proxy the rest ────────
  if (pathname.startsWith("/app/")) {
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
