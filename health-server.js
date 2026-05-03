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
const CLOUDFLARE_KEEPALIVE_STATUS_FILE = "/tmp/huggingpost-cloudflare-keepalive-status.json";

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
    { id: "linkedin",  name: "LinkedIn",   emoji: "💼", ready: !!(e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_ID !== "undefined"),
      setupUrl: "https://www.linkedin.com/developers/apps/new",
      envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"] },
    { id: "x",         name: "X / Twitter",emoji: "🐦", ready: !!(e.X_API_KEY),
      setupUrl: "https://developer.twitter.com/en/portal/projects-and-apps",
      envVars: ["X_API_KEY", "X_API_SECRET"] },
    { id: "facebook",  name: "Facebook",   emoji: "📘", ready: !!(e.FACEBOOK_APP_ID),
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"] },
    { id: "instagram", name: "Instagram",  emoji: "📸", ready: !!(e.FACEBOOK_APP_ID),
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
      note: "Uses same app as Facebook" },
    { id: "threads",   name: "Threads",    emoji: "🧵", ready: !!(e.THREADS_APP_ID),
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["THREADS_APP_ID", "THREADS_APP_SECRET"] },
    { id: "youtube",   name: "YouTube",    emoji: "▶️",  ready: !!(e.YOUTUBE_CLIENT_ID),
      setupUrl: "https://console.cloud.google.com/apis/credentials",
      envVars: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"] },
    { id: "tiktok",    name: "TikTok",     emoji: "🎵", ready: !!(e.TIKTOK_CLIENT_ID),
      setupUrl: "https://developers.tiktok.com/",
      envVars: ["TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET"] },
    { id: "reddit",    name: "Reddit",     emoji: "🤖", ready: !!(e.REDDIT_CLIENT_ID),
      setupUrl: "https://www.reddit.com/prefs/apps",
      envVars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"] },
    { id: "pinterest", name: "Pinterest",  emoji: "📌", ready: !!(e.PINTEREST_CLIENT_ID),
      setupUrl: "https://developers.pinterest.com/apps/",
      envVars: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"] },
    { id: "discord",   name: "Discord",    emoji: "🎮", ready: !!(e.DISCORD_CLIENT_ID),
      setupUrl: "https://discord.com/developers/applications",
      envVars: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN_ID"] },
    { id: "slack",     name: "Slack",      emoji: "💬", ready: !!(e.SLACK_ID),
      setupUrl: "https://api.slack.com/apps?new_app=1",
      envVars: ["SLACK_ID", "SLACK_SECRET", "SLACK_SIGNING_SECRET"] },
  ];
}

// Returns detailed per-platform OAuth setup guide data.
// publicUrl: "https://somratpro-huggingpost.hf.space" (no trailing slash)
function getOAuthPlatformDetails(publicUrl) {
  const cb = (provider) => `${publicUrl}/integrations/social/${provider}`;
  const e = process.env;
  return [
    {
      id: "linkedin",
      name: "LinkedIn",
      emoji: "💼",
      setupUrl: "https://www.linkedin.com/developers/apps/new",
      docsUrl: "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
      callbackUrl: cb("linkedin"),
      envVars: [
        { name: "LINKEDIN_CLIENT_ID",     desc: "Client ID",     set: !!e.LINKEDIN_CLIENT_ID },
        { name: "LINKEDIN_CLIENT_SECRET", desc: "Client Secret", set: !!e.LINKEDIN_CLIENT_SECRET },
      ],
      steps: [
        { title: "Create a LinkedIn App", body: 'Visit the developer portal. Create a new app; set <strong>App type = Web</strong>.' },
        { title: "Add OAuth redirect URL", body: 'In the <strong>Auth</strong> tab → OAuth 2.0 settings, paste the callback URL below.' },
        { title: "Enable products", body: 'Add <strong>Sign In with LinkedIn using OpenID Connect</strong> and <strong>Share on LinkedIn</strong> products.' },
        { title: "Copy credentials", body: 'From the Auth tab, copy <strong>Client ID</strong> and <strong>Client Secret</strong>.' },
        { title: "Add to Space secrets", body: 'Open your HF Space settings, add both env vars below, then restart the Space.' },
      ],
    },
    {
      id: "x",
      name: "X / Twitter",
      emoji: "🐦",
      setupUrl: "https://developer.twitter.com/en/portal/projects-and-apps",
      docsUrl: "https://developer.twitter.com/en/docs/authentication/oauth-1-0a",
      callbackUrl: cb("x"),
      envVars: [
        { name: "X_API_KEY",        desc: "API Key (Consumer Key)",    set: !!e.X_API_KEY },
        { name: "X_API_SECRET",     desc: "API Secret (Consumer Secret)", set: !!e.X_API_SECRET },
      ],
      steps: [
        { title: "Create an X Developer App", body: 'Apply for a developer account at <a href="https://developer.twitter.com" target="_blank" rel="noopener" style="color:#f472b6">developer.twitter.com</a> if you don\'t have one. Create a new project + app.' },
        { title: "Enable OAuth 1.0a + set permissions", body: 'On your app page → <strong>User authentication settings → Set up</strong>. Enable <strong>OAuth 1.0a</strong>. Set App permissions to <strong>Read and Write</strong>. Set Type of App to <strong>Native App</strong> (⚠️ must be Native App, not Web App — Web App breaks OAuth 1.0a).' },
        { title: "Add callback URL", body: 'In the same setup screen, under <strong>Callback URI / Redirect URL</strong>, paste the Callback URL shown below.' },
        { title: "Get your Consumer Secret", body: '<strong>⚠️ The Consumer Secret (X_API_SECRET) is only shown once</strong> — right after app creation, or after you click <strong>Regenerate</strong> on the Consumer Key row in the Keys &amp; Tokens tab.<br><br>If you don\'t have it saved: go to <strong>Keys &amp; Tokens → OAuth 1.0 Keys → Regenerate</strong>. Copy <em>both</em> the new Consumer Key and Consumer Secret that appear in the popup.' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings → Variables &amp; Secrets, then restart the Space.' },
      ],
    },
    {
      id: "facebook",
      name: "Facebook",
      emoji: "📘",
      setupUrl: "https://developers.facebook.com/apps/create/",
      docsUrl: "https://developers.facebook.com/docs/facebook-login/web",
      callbackUrl: cb("facebook"),
      envVars: [
        { name: "FACEBOOK_APP_ID",     desc: "App ID",     set: !!e.FACEBOOK_APP_ID },
        { name: "FACEBOOK_APP_SECRET", desc: "App Secret", set: !!e.FACEBOOK_APP_SECRET },
      ],
      steps: [
        { title: "Create a Meta App", body: 'Go to Meta for Developers. Create a new app with use case <strong>Authenticate and request data from users</strong>.' },
        { title: "Add Facebook Login product", body: 'In the app dashboard, click <strong>Add Product</strong> → Facebook Login → Web.' },
        { title: "Add callback URL", body: 'In Facebook Login settings → Valid OAuth Redirect URIs, paste the callback URL below.' },
        { title: "Request permissions", body: 'Add <strong>pages_manage_posts</strong>, <strong>pages_read_engagement</strong>, <strong>publish_to_groups</strong> permissions.' },
        { title: "Copy credentials", body: 'From <strong>App Settings → Basic</strong>, copy App ID and App Secret.' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "instagram",
      name: "Instagram",
      emoji: "📸",
      setupUrl: "https://developers.facebook.com/apps/create/",
      docsUrl: "https://developers.facebook.com/docs/instagram-api",
      callbackUrl: cb("instagram"),
      envVars: [
        { name: "FACEBOOK_APP_ID",     desc: "App ID (same as Facebook app)", set: !!e.FACEBOOK_APP_ID },
        { name: "FACEBOOK_APP_SECRET", desc: "App Secret (same as Facebook app)", set: !!e.FACEBOOK_APP_SECRET },
      ],
      steps: [
        { title: "Use the Facebook app", body: 'Instagram uses the same Meta app as Facebook — configure Facebook first.' },
        { title: "Add Instagram Graph API product", body: 'In your Meta app dashboard, click <strong>Add Product</strong> → Instagram Graph API.' },
        { title: "Connect an Instagram Business account", body: 'Your Instagram account must be a <strong>Professional (Business or Creator)</strong> account linked to a Facebook Page.' },
        { title: "Add callback URL", body: 'In Instagram Login settings → Valid OAuth Redirect URIs, paste the callback URL below.' },
        { title: "No extra env vars needed", body: 'Instagram and Facebook share <code>FACEBOOK_APP_ID</code> and <code>FACEBOOK_APP_SECRET</code>.' },
      ],
    },
    {
      id: "threads",
      name: "Threads",
      emoji: "🧵",
      setupUrl: "https://developers.facebook.com/apps/create/",
      docsUrl: "https://developers.facebook.com/docs/threads",
      callbackUrl: cb("threads"),
      envVars: [
        { name: "THREADS_APP_ID",     desc: "App ID",     set: !!e.THREADS_APP_ID },
        { name: "THREADS_APP_SECRET", desc: "App Secret", set: !!e.THREADS_APP_SECRET },
      ],
      steps: [
        { title: "Create a Meta App", body: 'Create a Meta Developer app (separate from Facebook/Instagram if you prefer clean separation).' },
        { title: "Add Threads API product", body: 'In the app dashboard, click <strong>Add Product</strong> → Threads API.' },
        { title: "Add callback URL", body: 'In Threads API settings → Redirect URI, paste the callback URL below.' },
        { title: "Copy credentials", body: 'From <strong>App Settings → Basic</strong>, copy App ID and App Secret.' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "youtube",
      name: "YouTube",
      emoji: "▶️",
      setupUrl: "https://console.cloud.google.com/apis/credentials",
      docsUrl: "https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps",
      callbackUrl: cb("youtube"),
      envVars: [
        { name: "YOUTUBE_CLIENT_ID",     desc: "OAuth 2.0 Client ID",     set: !!e.YOUTUBE_CLIENT_ID },
        { name: "YOUTUBE_CLIENT_SECRET", desc: "OAuth 2.0 Client Secret", set: !!e.YOUTUBE_CLIENT_SECRET },
      ],
      steps: [
        { title: "Create a Google Cloud project", body: 'Go to Google Cloud Console. Create a new project (or use existing).' },
        { title: "Enable YouTube Data API v3", body: 'In APIs & Services → Library, search for <strong>YouTube Data API v3</strong> and enable it.' },
        { title: "Create OAuth credentials", body: 'In APIs & Services → Credentials, click <strong>Create Credentials → OAuth client ID</strong>. Set type to <strong>Web application</strong>.' },
        { title: "Add callback URL", body: 'Under Authorized redirect URIs, paste the callback URL below.' },
        { title: "Configure OAuth consent screen", body: 'Set up consent screen with your app name. Add <strong>YouTube</strong> scopes.' },
        { title: "Copy credentials", body: 'Download or copy the <strong>Client ID</strong> and <strong>Client Secret</strong>.' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "tiktok",
      name: "TikTok",
      emoji: "🎵",
      setupUrl: "https://developers.tiktok.com/",
      docsUrl: "https://developers.tiktok.com/doc/login-kit-web",
      callbackUrl: cb("tiktok"),
      envVars: [
        { name: "TIKTOK_CLIENT_ID",     desc: "Client Key",    set: !!e.TIKTOK_CLIENT_ID },
        { name: "TIKTOK_CLIENT_SECRET", desc: "Client Secret", set: !!e.TIKTOK_CLIENT_SECRET },
      ],
      steps: [
        { title: "Apply for TikTok Developer access", body: 'Sign in at developers.tiktok.com. Apply for developer access (may take 1-2 days).' },
        { title: "Create an app", body: 'Create a new app. Set <strong>Platform: Web</strong>.' },
        { title: "Add Login Kit", body: 'Add <strong>Login Kit</strong> product. This enables OAuth for your app.' },
        { title: "Add callback URL", body: 'In Login Kit settings → Redirect domain, add your HF Space hostname. In redirect URI, paste the callback URL below.' },
        { title: "Request Content Posting API", body: 'Add <strong>Content Posting API</strong> product for posting videos/photos.' },
        { title: "Copy credentials", body: 'From app overview, copy <strong>Client Key</strong> (as CLIENT_ID) and <strong>Client Secret</strong>.' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "reddit",
      name: "Reddit",
      emoji: "🤖",
      setupUrl: "https://www.reddit.com/prefs/apps",
      docsUrl: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
      callbackUrl: cb("reddit"),
      envVars: [
        { name: "REDDIT_CLIENT_ID",     desc: "Client ID (under app name)", set: !!e.REDDIT_CLIENT_ID },
        { name: "REDDIT_CLIENT_SECRET", desc: "Secret",                     set: !!e.REDDIT_CLIENT_SECRET },
      ],
      steps: [
        { title: "Go to Reddit App Preferences", body: 'Visit reddit.com/prefs/apps while logged in.' },
        { title: "Create a new app", body: 'Click <strong>create another app…</strong>. Set type to <strong>web app</strong>.' },
        { title: "Add callback URL", body: 'In the <strong>redirect uri</strong> field, paste the callback URL below.' },
        { title: "Copy credentials", body: 'The Client ID is the string below the app name. Client Secret is labelled "secret".' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "pinterest",
      name: "Pinterest",
      emoji: "📌",
      setupUrl: "https://developers.pinterest.com/apps/",
      docsUrl: "https://developers.pinterest.com/docs/getting-started/set-up-app/",
      callbackUrl: cb("pinterest"),
      envVars: [
        { name: "PINTEREST_CLIENT_ID",     desc: "App ID",     set: !!e.PINTEREST_CLIENT_ID },
        { name: "PINTEREST_CLIENT_SECRET", desc: "App Secret", set: !!e.PINTEREST_CLIENT_SECRET },
      ],
      steps: [
        { title: "Create a Pinterest App", body: 'Go to Pinterest Developer Portal and create a new app.' },
        { title: "Add redirect URI", body: 'In app settings, add the callback URL below as a redirect URI.' },
        { title: "Request scopes", body: 'Request <strong>boards:read</strong>, <strong>pins:read</strong>, <strong>pins:write</strong> scopes.' },
        { title: "Copy credentials", body: 'Copy App ID and App Secret from the app settings.' },
        { title: "Add to Space secrets", body: 'Add both env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "discord",
      name: "Discord",
      emoji: "🎮",
      setupUrl: "https://discord.com/developers/applications",
      docsUrl: "https://discord.com/developers/docs/topics/oauth2",
      callbackUrl: cb("discord"),
      envVars: [
        { name: "DISCORD_CLIENT_ID",     desc: "Application ID",      set: !!e.DISCORD_CLIENT_ID },
        { name: "DISCORD_CLIENT_SECRET", desc: "Client Secret",        set: !!e.DISCORD_CLIENT_SECRET },
        { name: "DISCORD_BOT_TOKEN_ID",  desc: "Bot Token",            set: !!e.DISCORD_BOT_TOKEN_ID },
      ],
      steps: [
        { title: "Create a Discord Application", body: 'Go to Discord Developer Portal → New Application.' },
        { title: "Add redirect URL", body: 'In <strong>OAuth2 → Redirects</strong>, paste the callback URL below.' },
        { title: "Create a Bot", body: 'In the <strong>Bot</strong> section, create a bot. Enable <strong>Message Content Intent</strong>.' },
        { title: "Copy credentials", body: 'Copy Client ID and Client Secret from OAuth2 tab. Copy Bot Token from Bot tab.' },
        { title: "Add to Space secrets", body: 'Add all three env vars below to your HF Space settings, then restart.' },
      ],
    },
    {
      id: "slack",
      name: "Slack",
      emoji: "💬",
      setupUrl: "https://api.slack.com/apps?new_app=1",
      docsUrl: "https://api.slack.com/authentication/oauth-v2",
      callbackUrl: cb("slack"),
      envVars: [
        { name: "SLACK_ID",             desc: "Client ID",      set: !!e.SLACK_ID },
        { name: "SLACK_SECRET",         desc: "Client Secret",  set: !!e.SLACK_SECRET },
        { name: "SLACK_SIGNING_SECRET", desc: "Signing Secret", set: !!e.SLACK_SIGNING_SECRET },
      ],
      steps: [
        { title: "Create a Slack App", body: 'Go to api.slack.com/apps → Create New App → From scratch.' },
        { title: "Add OAuth redirect URL", body: 'In <strong>OAuth & Permissions → Redirect URLs</strong>, paste the callback URL below.' },
        { title: "Add Bot Token Scopes", body: 'Under Bot Token Scopes, add: <code>channels:join</code>, <code>chat:write</code>, <code>channels:read</code>, <code>groups:read</code>.' },
        { title: "Install to workspace", body: 'Click <strong>Install to Workspace</strong> to generate tokens.' },
        { title: "Copy credentials", body: 'From <strong>Basic Information</strong>: App Credentials has Client ID, Client Secret, Signing Secret.' },
        { title: "Add to Space secrets", body: 'Add all three env vars below to your HF Space settings, then restart.' },
      ],
    },
  ];
}

function renderSetupPage() {
  const spaceHost = process.env.SPACE_HOST || null;
  const spaceId = process.env.SPACE_ID || null;
  const publicUrl = spaceHost ? `https://${spaceHost}` : "http://localhost:7860";
  const settingsUrl = spaceId
    ? `https://huggingface.co/spaces/${spaceId}/settings`
    : "https://huggingface.co/settings/spaces";

  const platforms = getOAuthPlatformDetails(publicUrl);
  const configuredCount = platforms.filter(p => p.envVars.every(v => v.set)).length;

  // Build sidebar items
  const sidebarItems = platforms.map((p, i) => {
    const allSet = p.envVars.every(v => v.set);
    const anySet = p.envVars.some(v => v.set);
    const indicator = allSet ? "✅" : anySet ? "⚠️" : "⚪";
    return `<button class="plat-tab${i === 0 ? " active" : ""}" onclick="show(${i})" id="tab-${i}">
      <span class="tab-emoji">${p.emoji}</span>
      <span class="tab-name">${p.name}</span>
      <span class="tab-indicator">${indicator}</span>
    </button>`;
  }).join("");

  // Build detail panels
  const panels = platforms.map((p, i) => {
    const allSet = p.envVars.every(v => v.set);

    const stepsList = p.steps.map((s, si) =>
      `<div class="step"><div class="step-num">${si + 1}</div><div><div class="step-title">${s.title}</div><div class="step-body">${s.body}</div></div></div>`
    ).join("");

    const envRows = p.envVars.map(v =>
      `<div class="env-row">
        <div class="env-info">
          <code class="env-name">${v.name}</code>
          <span class="env-desc">${v.desc}</span>
        </div>
        <div class="env-actions">
          ${v.set ? '<span class="badge badge-on" style="font-size:.7rem">Set ✓</span>' : '<span class="badge badge-off" style="font-size:.7rem">Not set</span>'}
          <button class="copy-btn" onclick="copy('${v.name}', this)">Copy name</button>
        </div>
      </div>`
    ).join("");

    const statusBanner = allSet
      ? `<div class="status-banner banner-ok">✅ All credentials configured — restart Space if you just added them.</div>`
      : p.envVars.some(v => v.set)
      ? `<div class="status-banner banner-warn">⚠️ Partially configured — check missing env vars below.</div>`
      : `<div class="status-banner banner-info">ℹ️ Not yet configured — follow the steps below.</div>`;

    return `<div class="panel${i === 0 ? " active" : ""}" id="panel-${i}">
      <div class="panel-header">
        <span class="panel-emoji">${p.emoji}</span>
        <div>
          <h2 class="panel-title">${p.name}</h2>
          <a class="portal-link" href="${p.setupUrl}" target="_blank" rel="noopener">Open ${p.name} Developer Portal →</a>
          ${p.docsUrl ? `<a class="portal-link" href="${p.docsUrl}" target="_blank" rel="noopener" style="margin-left:12px">Docs →</a>` : ""}
        </div>
      </div>

      ${statusBanner}

      <h3 class="section-label">Setup Steps</h3>
      <div class="steps-list">${stepsList}</div>

      <h3 class="section-label">Callback URL</h3>
      <div class="copy-block">
        <span class="copy-block-text" id="cb-${i}">${p.callbackUrl}</span>
        <button class="copy-btn copy-btn-primary" onclick="copy('${p.callbackUrl}', this)">Copy</button>
      </div>
      <p class="hint">Paste this URL wherever the developer portal asks for "Redirect URI", "Callback URL", or "OAuth Redirect URL".</p>

      <h3 class="section-label">Space Secrets to Add</h3>
      <div class="env-list">${envRows}</div>
      <div class="settings-cta">
        <a href="${settingsUrl}" target="_blank" rel="noopener" class="settings-btn">Open Space Settings → Variables &amp; Secrets</a>
        <p class="hint">After adding secrets, click <strong>Restart Space</strong> for them to take effect.</p>
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Platform Setup — HuggingPost</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f172a;--sidebar:#0d1829;--card:rgba(30,41,59,.75);--border:rgba(255,255,255,.08);--accent:linear-gradient(135deg,#ec4899,#8b5cf6);--text:#f8fafc;--dim:#94a3b8;--ok:#10b981;--warn:#f59e0b;--err:#ef4444;--blue:#3b82f6;--pink:#f472b6}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Outfit',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;
  background-image:radial-gradient(at 0% 0%,rgba(236,72,153,.12) 0,transparent 50%),radial-gradient(at 100% 100%,rgba(139,92,246,.12) 0,transparent 50%)}
/* Top bar */
.topbar{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--border);background:rgba(15,23,42,.8);backdrop-filter:blur(8px);flex-shrink:0}
.topbar a{color:var(--dim);text-decoration:none;font-size:.85rem;display:flex;align-items:center;gap:6px}
.topbar a:hover{color:var(--text)}
.topbar h1{font-size:1.1rem;font-weight:600;background:var(--accent);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.topbar-right{margin-left:auto;font-size:.8rem;color:var(--dim)}
/* Layout */
.layout{display:flex;flex:1;overflow:hidden}
/* Sidebar */
.sidebar{width:220px;flex-shrink:0;background:var(--sidebar);border-right:1px solid var(--border);overflow-y:auto;padding:12px 8px}
.sidebar-label{font-size:.65rem;text-transform:uppercase;color:var(--dim);letter-spacing:.1em;padding:4px 10px 8px}
.plat-tab{width:100%;background:none;border:none;color:var(--text);font:inherit;font-size:.88rem;display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;cursor:pointer;text-align:left;transition:background .15s}
.plat-tab:hover{background:rgba(255,255,255,.05)}
.plat-tab.active{background:rgba(236,72,153,.12);color:var(--pink)}
.tab-emoji{font-size:1rem;width:22px;text-align:center;flex-shrink:0}
.tab-name{flex:1}
.tab-indicator{font-size:.8rem}
/* Main panel */
.main{flex:1;overflow-y:auto;padding:28px 32px}
.panel{display:none;animation:fadein .2s ease}
.panel.active{display:block}
@keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.panel-header{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px}
.panel-emoji{font-size:2.5rem;flex-shrink:0;margin-top:2px}
.panel-title{font-size:1.5rem;font-weight:600;margin-bottom:4px}
.portal-link{color:var(--pink);font-size:.82rem;text-decoration:none}
.portal-link:hover{text-decoration:underline}
/* Status banner */
.status-banner{padding:10px 14px;border-radius:10px;font-size:.85rem;margin-bottom:20px}
.banner-ok{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#6ee7b7}
.banner-warn{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);color:#fcd34d}
.banner-info{background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);color:#93c5fd}
/* Section labels */
.section-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:20px 0 10px}
/* Steps */
.steps-list{display:flex;flex-direction:column;gap:2px}
.step{display:flex;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid var(--border)}
.step-num{width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:.7rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step-title{font-size:.88rem;font-weight:600;margin-bottom:3px}
.step-body{font-size:.82rem;color:var(--dim);line-height:1.55}
.step-body code{background:rgba(255,255,255,.1);padding:1px 5px;border-radius:4px;font-size:.8em;color:var(--text)}
/* Callback URL copy block */
.copy-block{display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:6px}
.copy-block-text{flex:1;font-size:.82rem;color:#c4b5fd;word-break:break-all;font-family:monospace}
/* Env vars */
.env-list{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.env-row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px}
.env-info{flex:1;display:flex;flex-direction:column;gap:3px}
.env-name{font-size:.82rem;color:#c4b5fd;background:rgba(139,92,246,.1);padding:2px 7px;border-radius:5px;width:fit-content}
.env-desc{font-size:.76rem;color:var(--dim)}
.env-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
/* Buttons */
.copy-btn{background:rgba(255,255,255,.07);border:1px solid var(--border);color:var(--text);font:inherit;font-size:.75rem;padding:5px 10px;border-radius:7px;cursor:pointer;transition:background .15s;flex-shrink:0}
.copy-btn:hover{background:rgba(255,255,255,.12)}
.copy-btn.copied{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.3);color:var(--ok)}
.copy-btn-primary{background:rgba(236,72,153,.15);border-color:rgba(236,72,153,.3);color:var(--pink);font-size:.82rem;padding:6px 14px}
.copy-btn-primary:hover{background:rgba(236,72,153,.25)}
.settings-btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-size:.88rem;font-weight:600;transition:opacity .2s}
.settings-btn:hover{opacity:.85}
.settings-cta{margin-top:4px}
/* Badges */
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-weight:600}
.badge-on{background:rgba(16,185,129,.12);color:var(--ok)}
.badge-off{background:rgba(239,68,68,.12);color:var(--err)}
/* Hint */
.hint{font-size:.78rem;color:var(--dim);margin-top:6px;line-height:1.5;margin-bottom:16px}
/* Mobile */
@media(max-width:700px){
  body{overflow:auto;height:auto}
  .layout{flex-direction:column;overflow:visible}
  .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;padding:8px;gap:4px}
  .sidebar-label{display:none}
  .plat-tab{width:auto;flex:0 0 auto;padding:6px 10px}
  .tab-name{display:none}
  .main{padding:16px}
}
</style>
</head>
<body>
<div class="topbar">
  <a href="/">← Dashboard</a>
  <h1>Platform Setup Guide</h1>
  <span class="topbar-right">${configuredCount}/${platforms.length} configured</span>
</div>
<div class="layout">
  <nav class="sidebar">
    <div class="sidebar-label">OAuth Platforms</div>
    ${sidebarItems}
  </nav>
  <main class="main">
    ${panels}
  </main>
</div>
<script>
const PLATFORM_IDS = ${JSON.stringify(platforms.map(p => p.id))};
function show(i) {
  document.querySelectorAll('.plat-tab').forEach((t,j) => t.classList.toggle('active', j===i));
  document.querySelectorAll('.panel').forEach((p,j) => p.classList.toggle('active', j===i));
  if (PLATFORM_IDS[i]) history.replaceState(null, '', '#' + PLATFORM_IDS[i]);
}
function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
  }).catch(() => {
    // fallback for non-HTTPS
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
  });
}
// Hash-based deep-linking: /setup#linkedin jumps to LinkedIn tab
(function() {
  const hash = location.hash.replace('#','').toLowerCase();
  if (hash) {
    const idx = PLATFORM_IDS.indexOf(hash);
    if (idx !== -1) show(idx);
  }
})();
</script>
</body>
</html>`;
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
    pathname === "" ||
    pathname === "/setup" ||
    pathname === "/setup/"
  );
}

// ============================================================================
// UptimeRobot helpers
// ============================================================================

function getKeepaliveStatus() {
  try {
    if (fs.existsSync(CLOUDFLARE_KEEPALIVE_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(CLOUDFLARE_KEEPALIVE_STATUS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function renderTile({ title, value, detail = "", tone = "neutral", meta = "" }) {
  return `<article class="tile ${tone}">
    <div class="tile-head">
      <span class="tile-title">${escapeHtml(title)}</span>
      <span class="tile-dot"></span>
    </div>
    <div class="tile-value">${value}</div>
    ${detail ? `<div class="tile-detail">${detail}</div>` : ""}
    ${meta ? `<div class="tile-meta">${meta}</div>` : ""}
  </article>`;
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

function renderDashboard(data) {
  const syncStatus = String(data.sync?.status || "unknown");
  const syncTone = ["success", "restored", "synced", "configured"].includes(syncStatus)
    ? "ok"
    : syncStatus === "disabled"
      ? "warn"
      : "neutral";
  const backupDetail = data.sync?.message ? escapeHtml(data.sync.message) : "No status yet";

  const keepaliveConfigured = data.keepalive?.configured === true;
  const keepaliveStatus = String(
    data.keepalive?.status ||
      (process.env.CLOUDFLARE_WORKERS_TOKEN ? "pending" : "not configured"),
  );
  const keepAliveTone = keepaliveConfigured
    ? "ok"
    : process.env.CLOUDFLARE_WORKERS_TOKEN
      ? "warn"
      : "neutral";
  const keepAliveDetail = keepaliveConfigured
    ? `Pinging <code>${escapeHtml(data.keepalive.targetUrl || "/health")}</code>`
    : process.env.CLOUDFLARE_WORKERS_TOKEN
      ? "Worker pending or failed"
      : "Not configured";

  const platforms = getSocialPlatforms();
  const readyNow = platforms.filter(p => p.noOAuth);
  const needsSetup = platforms.filter(p => !p.noOAuth);
  const configuredCount = needsSetup.filter(p => p.ready).length;

  const needsSetupRows = needsSetup.map(p => {
    if (p.ready) {
      return `<div class="plat-row ready">
        <span class="plat-icon">${p.emoji}</span>
        <span class="plat-name">${p.name}</span>
        <span class="badge ok" style="font-size:0.72rem">Configured</span>
      </div>`;
    }
    return `<div class="plat-row">
      <span class="plat-icon" style="filter:grayscale(1);opacity:.5">${p.emoji}</span>
      <span class="plat-name" style="color:var(--dim)">${p.name}</span>
      <a class="setup-link" href="/setup#${p.id}" style="margin-right:4px">Setup guide →</a>
    </div>`;
  }).join("");

  const readyNowRows = readyNow.map(p => `
    <div class="plat-row ready">
      <span class="plat-icon">${p.emoji}</span>
      <span class="plat-name">${p.name}</span>
      <span style="font-size:0.75rem;color:var(--dim)">${p.note || ""}</span>
    </div>`).join("");

  const tiles = [
    renderTile({
      title: "Postiz Core",
      value: toneBadge(data.postizRunning ? "Online" : "Booting", data.postizRunning ? "ok" : "warn"),
      detail: `Backend Port ${POSTIZ_PORT}`,
      tone: data.postizRunning ? "ok" : "warn",
    }),
    renderTile({
      title: "Uptime",
      value: escapeHtml(data.uptimeHuman),
      detail: `Exposed on port ${PORT}`,
      tone: "neutral",
    }),
    renderTile({
      title: "Backup",
      value: toneBadge(syncStatus.toUpperCase(), syncTone),
      detail: backupDetail,
      tone: syncTone,
    }),
    renderTile({
      title: "Keep Awake",
      value: toneBadge(keepaliveConfigured ? "CF Cron" : keepaliveStatus.toUpperCase(), keepAliveTone),
      detail: keepAliveDetail,
      tone: keepAliveTone,
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingPost</title>
  <style>
    :root { color-scheme: dark; --bg:#08080f; --panel:#12111b; --panel2:#151421; --line:#26243a; --text:#f6f4ff; --muted:#7f7a9e; --soft:#b8b3d7; --good:#22c55e; --warn:#f5c542; --bad:#fb7185; --accent:#3b82f6; --accent2:#8b5cf6; --dim:#94a3b8; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); font-size:13px; }
    main { width:min(720px, calc(100% - 32px)); margin:0 auto; padding:36px 0 44px; }
    header { text-align:center; margin-bottom:22px; }
    h1 { margin:0; font-size:1.65rem; line-height:1; letter-spacing:0; }
    .subtitle { margin-top:12px; color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.14em; font-weight:800; }
    
    .hero-action { display:flex; width:100%; min-height:46px; align-items:center; justify-content:center; border-radius:8px; background:linear-gradient(135deg, var(--accent), var(--accent2)); color:#ffffff; text-decoration:none; font-weight:850; font-size:.98rem; margin:24px 0 20px; transition: opacity 0.15s ease; }
    .hero-action:hover { opacity: 0.9; }
    .hero-action.booting { background:var(--panel2); color:var(--muted); cursor:wait; border:1px solid var(--line); }

    .overview { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-bottom:24px; }
    .tile { border:1px solid var(--line); background:var(--panel); border-radius:11px; padding:18px; min-height:124px; display:flex; flex-direction:column; gap:10px; position:relative; }
    .tile.ok { border-color:rgba(34,197,94,.22); }
    .tile.warn { border-color:rgba(245,197,66,.24); }
    .tile.off { border-color:rgba(251,113,133,.28); }
    .tile-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .tile-title { color:var(--muted); font-size:.67rem; letter-spacing:.18em; text-transform:uppercase; font-weight:850; }
    .tile-dot { width:7px; height:7px; border-radius:50%; background:var(--line); }
    .tile.ok .tile-dot { background:var(--good); }
    .tile.warn .tile-dot { background:var(--warn); }
    .tile.off .tile-dot { background:var(--bad); }
    .tile-value { font-size:1.12rem; font-weight:850; overflow-wrap:anywhere; }
    .tile-detail { color:var(--soft); line-height:1.45; font-size:.83rem; }
    .tile-meta { color:var(--muted); line-height:1.4; font-size:.75rem; margin-top:auto; overflow-wrap:anywhere; }

    .card { background:var(--panel); border:1px solid var(--line); border-radius:11px; padding:20px; margin-bottom:12px; }
    .card h2 { font-size:.7rem; text-transform:uppercase; color:var(--muted); letter-spacing:.1em; margin:0 0 16px; }
    .steps { list-style:none; padding:0; margin:0; }
    .steps li { display:flex; gap:12px; padding:12px 0; border-top:1px solid var(--line); }
    .steps li:first-child { border-top:none; padding-top:0; }
    .steps li::before { content: counter(step-counter); counter-increment: step-counter; width:22px; height:22px; border-radius:50%; background:var(--panel2); border:1px solid var(--line); color:var(--text); font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .steps { counter-reset: step-counter; }
    .s-title { font-weight:800; margin-bottom:4px; font-size:14px; }
    .s-note { color:var(--muted); line-height:1.5; font-size:12px; }

    .plat-row { display:flex; align-items:center; gap:10px; padding:10px 0; border-top:1px solid var(--line); font-size:13px; }
    .plat-row:first-child { border-top:none; }
    .plat-icon { font-size:16px; width:22px; text-align:center; flex-shrink:0; }
    .plat-name { flex:1; font-weight:700; }
    .setup-link { color:var(--accent2); font-size:11px; text-decoration:none; font-weight:800; }
    .setup-link:hover { text-decoration:underline; }

    .badge { display:inline-flex; align-items:center; width:max-content; border:1px solid var(--line); border-radius:999px; padding:5px 10px; font-size:.72rem; font-weight:850; line-height:1; text-transform:uppercase; }
    .badge.ok { color:var(--good); border-color:rgba(34,197,94,.34); background:rgba(34,197,94,.11); }
    .badge.warn { color:var(--warn); border-color:rgba(245,197,66,.34); background:rgba(245,197,66,.11); }
    .badge.off { color:var(--bad); border-color:rgba(251,113,133,.34); background:rgba(251,113,133,.11); }
    .badge.neutral { color:var(--soft); }

    code { background:var(--panel2); border:1px solid var(--line); border-radius:6px; padding:2px 6px; color:var(--text); font-size:.9em; }
    footer { color:var(--muted); text-align:center; font-size:.74rem; margin-top:18px; }
    footer .live { color:var(--good); }
    @media (max-width: 700px) { .overview { grid-template-columns:1fr; } main { width:min(100% - 22px, 720px); padding-top:28px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>📮 HuggingPost</h1>
      <div class="subtitle">Self-hosted Postiz Dashboard</div>
    </header>

    ${data.postizRunning
      ? `<a href="/app/auth" class="hero-action" target="_blank" rel="noopener">Open Postiz -></a>`
      : `<a href="#" class="hero-action booting" onclick="return false">Postiz is starting up (first boot ~5 min)...</a>`}

    <section class="overview">
      ${tiles}
    </section>

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
            <div class="s-title">Connect direct channels</div>
            <div class="s-note">Bluesky, Mastodon, Telegram, Dev.to, and Hashnode connect with just your credentials.</div>
          </div>
        </li>
        <li>
          <div>
            <div class="s-title">Enable OAuth platforms</div>
            <div class="s-note">LinkedIn, X, YouTube... require API keys. Use the <a href="/setup" class="setup-link">Setup Guide -></a> for instructions.</div>
          </div>
        </li>
      </ol>
    </div>

    <div class="card">
      <h2>✅ Works immediately (${readyNow.length} platforms)</h2>
      <div class="plat-list">
        ${readyNowRows}
      </div>
    </div>

    <div class="card">
      <h2>🔑 Needs API keys (${configuredCount}/${needsSetup.length} configured)</h2>
      <div class="plat-list">
        ${needsSetupRows}
      </div>
      <div style="margin-top:16px">
        <a href="/setup" class="hero-action" style="background:var(--panel2); border:1px solid var(--line); margin:0;">📖 View Full Setup Guide</a>
      </div>
    </div>

    <footer><span class="live">Live</span> status - Health endpoint: <code>/health</code></footer>
  </main>
  <script>
    async function refresh() {
      try {
        const d = await fetch('/status').then(r => r.json());
        if (d.postizRunning && document.querySelector('.hero-action.booting')) {
          location.reload();
        }
      } catch(e) {}
    }
    setInterval(refresh, 15000);
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
        keepalive: getKeepaliveStatus(),
      }));
    })();
    return;
  }

  // ── /setup — OAuth platform setup wizard ─────────────────────────────────
  if (pathname === "/setup" || pathname === "/setup/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSetupPage());
    return;
  }

  // ── /app/debug-logs — Temporary endpoint for debugging ───────────────────
  if (pathname === "/app/debug-logs") {
    try {
      const errLog = fs.existsSync("/root/.pm2/logs/backend-error.log") 
        ? fs.readFileSync("/root/.pm2/logs/backend-error.log", "utf8") 
        : "No backend-error.log found";
      const outLog = fs.existsSync("/root/.pm2/logs/backend-out.log")
        ? fs.readFileSync("/root/.pm2/logs/backend-out.log", "utf8")
        : "No backend-out.log found";
      
      const cfProxyLog = fs.existsSync("/tmp/huggingpost-cloudflare-proxy.env")
        ? fs.readFileSync("/tmp/huggingpost-cloudflare-proxy.env", "utf8")
        : "No proxy env";

      const out = `=== BACKEND ERROR LOG ===\n${errLog}\n\n=== BACKEND OUT LOG ===\n${outLog}\n\n=== PROXY ENV ===\n${cfProxyLog}`;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(out);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error reading logs: " + e.message);
    }
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
  if (pathname === "/app" || pathname === "/app/") {
    // Postiz Next.js root redirect to /launches sometimes fails with basePath 
    // + trailingSlash:true, leaving users on a blank /app/ page after signup.
    // Force the redirect here. Next.js middleware will still redirect to
    // /auth/login if they aren't authenticated yet.
    res.writeHead(302, { Location: "/app/launches/" + (parsedUrl.search || "") });
    res.end();
    return;
  }

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
