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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};
const POSTIZ_HOST = "127.0.0.1";
const POSTIZ_PORT = 5000;

const startTime = Date.now();
const HF_BACKUP_ENABLED = !!process.env.HF_TOKEN;
const SYNC_INTERVAL = process.env.SYNC_INTERVAL || "300";
const CLOUDFLARE_KEEPALIVE_STATUS_FILE =
  "/tmp/huggingpost-cloudflare-keepalive-status.json";

// Social platform env-var presence check (for dashboard status grid).
// Each entry: { name, emoji, ready: bool, setupUrl, envVars, noOAuth }
function getSocialPlatforms() {
  const e = process.env;
  return [
    // ── Works immediately (connect inside Postiz UI, no env vars needed) ─────
    {
      name: "Bluesky",
      emoji: "🦋",
      noOAuth: true,
      ready: true,
      note: "Username + App Password in Postiz",
    },
    {
      name: "Mastodon",
      emoji: "🐘",
      noOAuth: true,
      ready: true,
      note: "Instance URL + credentials in Postiz",
    },
    {
      name: "Telegram",
      emoji: "✈️",
      noOAuth: true,
      ready: true,
      note: "Bot token from @BotFather in Postiz",
    },
    {
      name: "Nostr",
      emoji: "🔑",
      noOAuth: true,
      ready: true,
      note: "Private key in Postiz",
    },
    {
      name: "Lemmy",
      emoji: "🐾",
      noOAuth: true,
      ready: true,
      note: "Instance + credentials in Postiz",
    },
    {
      name: "Warpcast",
      emoji: "🟣",
      noOAuth: true,
      ready: true,
      note: "FID + private key in Postiz",
    },
    {
      name: "Dev.to",
      emoji: "💻",
      noOAuth: true,
      ready: true,
      note: "API key from dev.to settings",
    },
    {
      name: "Hashnode",
      emoji: "📰",
      noOAuth: true,
      ready: true,
      note: "API token from Hashnode settings",
    },
    // ── Needs OAuth app (env vars required) ───────────────────────────────────
    {
      id: "linkedin",
      name: "LinkedIn",
      emoji: "💼",
      ready: !!(e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_ID !== "undefined"),
      setupUrl: "https://www.linkedin.com/developers/apps/new",
      envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    },
    {
      id: "x",
      name: "X / Twitter",
      emoji: "🐦",
      ready: !!e.X_API_KEY,
      setupUrl: "https://developer.twitter.com/en/portal/projects-and-apps",
      envVars: ["X_API_KEY", "X_API_SECRET"],
    },
    {
      id: "facebook",
      name: "Facebook",
      emoji: "📘",
      ready: !!e.FACEBOOK_APP_ID,
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    },
    {
      id: "instagram",
      name: "Instagram",
      emoji: "📸",
      ready: !!e.FACEBOOK_APP_ID,
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
      note: "Uses same app as Facebook",
    },
    {
      id: "threads",
      name: "Threads",
      emoji: "🧵",
      ready: !!e.THREADS_APP_ID,
      setupUrl: "https://developers.facebook.com/apps/create/",
      envVars: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
    },
    {
      id: "youtube",
      name: "YouTube",
      emoji: "▶️",
      ready: !!e.YOUTUBE_CLIENT_ID,
      setupUrl: "https://console.cloud.google.com/apis/credentials",
      envVars: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
    },
    {
      id: "tiktok",
      name: "TikTok",
      emoji: "🎵",
      ready: !!e.TIKTOK_CLIENT_ID,
      setupUrl: "https://developers.tiktok.com/",
      envVars: ["TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET"],
    },
    {
      id: "reddit",
      name: "Reddit",
      emoji: "🤖",
      ready: !!e.REDDIT_CLIENT_ID,
      setupUrl: "https://www.reddit.com/prefs/apps",
      envVars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    },
    {
      id: "pinterest",
      name: "Pinterest",
      emoji: "📌",
      ready: !!e.PINTEREST_CLIENT_ID,
      setupUrl: "https://developers.pinterest.com/apps/",
      envVars: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],
    },
    {
      id: "discord",
      name: "Discord",
      emoji: "🎮",
      ready: !!e.DISCORD_CLIENT_ID,
      setupUrl: "https://discord.com/developers/applications",
      envVars: [
        "DISCORD_CLIENT_ID",
        "DISCORD_CLIENT_SECRET",
        "DISCORD_BOT_TOKEN_ID",
      ],
    },
    {
      id: "slack",
      name: "Slack",
      emoji: "💬",
      ready: !!e.SLACK_ID,
      setupUrl: "https://api.slack.com/apps?new_app=1",
      envVars: ["SLACK_ID", "SLACK_SECRET", "SLACK_SIGNING_SECRET"],
    },
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
      docsUrl:
        "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
      callbackUrl: cb("linkedin"),
      envVars: [
        {
          name: "LINKEDIN_CLIENT_ID",
          desc: "Client ID",
          set: !!e.LINKEDIN_CLIENT_ID,
        },
        {
          name: "LINKEDIN_CLIENT_SECRET",
          desc: "Client Secret",
          set: !!e.LINKEDIN_CLIENT_SECRET,
        },
      ],
      steps: [
        {
          title: "Create a LinkedIn App",
          body: "Visit the developer portal. Create a new app; set <strong>App type = Web</strong>.",
        },
        {
          title: "Add OAuth redirect URL",
          body: "In the <strong>Auth</strong> tab → OAuth 2.0 settings, paste the callback URL below.",
        },
        {
          title: "Enable products",
          body: "Add <strong>Sign In with LinkedIn using OpenID Connect</strong> and <strong>Share on LinkedIn</strong> products.",
        },
        {
          title: "Copy credentials",
          body: "From the Auth tab, copy <strong>Client ID</strong> and <strong>Client Secret</strong>.",
        },
        {
          title: "Add to Space secrets",
          body: "Open your HF Space settings, add both env vars below, then restart the Space.",
        },
      ],
    },
    {
      id: "x",
      name: "X / Twitter",
      emoji: "🐦",
      setupUrl: "https://developer.twitter.com/en/portal/projects-and-apps",
      docsUrl:
        "https://developer.twitter.com/en/docs/authentication/oauth-1-0a",
      callbackUrl: cb("x"),
      envVars: [
        {
          name: "X_API_KEY",
          desc: "API Key (Consumer Key)",
          set: !!e.X_API_KEY,
        },
        {
          name: "X_API_SECRET",
          desc: "API Secret (Consumer Secret)",
          set: !!e.X_API_SECRET,
        },
      ],
      steps: [
        {
          title: "Create an X Developer App",
          body: 'Go to <a href="https://developer.twitter.com" target="_blank" rel="noopener">developer.twitter.com</a>. Apply for a developer account if needed. Create a new project + app.',
        },
        {
          title: "Configure User Authentication Settings",
          body: "On your app page → <strong>User authentication settings → Set up</strong>. Set ALL THREE of these, then click Save:<br><br><strong>1. App permissions:</strong> <strong>Read and write</strong> (default is Read-only — must change this)<br><strong>2. Type of App:</strong> <strong>Native App</strong> (Public client) — ⚠️ NOT Web App, Web App causes error code 32<br><strong>3. Callback URI:</strong> paste the Callback URL shown below. Website URL = your HF Space URL.<br><br>Save when done.",
        },
        {
          title: "Regenerate Consumer Keys (required after saving settings)",
          body: "Go to <strong>Keys &amp; Tokens</strong> tab → <strong>OAuth 1.0 Keys</strong> section → click <strong>Regenerate</strong> next to Consumer Key.<br><br><strong>⚠️ You must regenerate after changing User Auth Settings</strong> — existing keys don't pick up new permissions.<br><br>The Regenerate popup shows BOTH values together — copy them immediately:<br>• <strong>API Key</strong> = your <strong>X_API_KEY</strong><br>• <strong>API Key Secret</strong> = your <strong>X_API_SECRET</strong><br><br>⚠️ Do NOT use Bearer Token, Access Token/Secret, or OAuth 2.0 Client ID/Secret.",
        },
        {
          title: "Add to Space secrets and restart",
          body: "Add <strong>X_API_KEY</strong> and <strong>X_API_SECRET</strong> to HF Space → Settings → Variables &amp; Secrets. Then <strong>Restart the Space</strong> to load the new values.",
        },
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
        { name: "FACEBOOK_APP_ID", desc: "App ID", set: !!e.FACEBOOK_APP_ID },
        {
          name: "FACEBOOK_APP_SECRET",
          desc: "App Secret",
          set: !!e.FACEBOOK_APP_SECRET,
        },
      ],
      steps: [
        {
          title: "Create a Meta App",
          body: "Go to Meta for Developers. Create a new app with use case <strong>Authenticate and request data from users</strong>.",
        },
        {
          title: "Add Facebook Login product",
          body: "In the app dashboard, click <strong>Add Product</strong> → Facebook Login → Web.",
        },
        {
          title: "Add callback URL",
          body: "In Facebook Login settings → Valid OAuth Redirect URIs, paste the callback URL below.",
        },
        {
          title: "Request permissions",
          body: "Add <strong>pages_manage_posts</strong>, <strong>pages_read_engagement</strong>, <strong>publish_to_groups</strong> permissions.",
        },
        {
          title: "Copy credentials",
          body: "From <strong>App Settings → Basic</strong>, copy App ID and App Secret.",
        },
        {
          title: "Add to Space secrets",
          body: "Add both env vars below to your HF Space settings, then restart.",
        },
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
        {
          name: "FACEBOOK_APP_ID",
          desc: "App ID (same as Facebook app)",
          set: !!e.FACEBOOK_APP_ID,
        },
        {
          name: "FACEBOOK_APP_SECRET",
          desc: "App Secret (same as Facebook app)",
          set: !!e.FACEBOOK_APP_SECRET,
        },
      ],
      steps: [
        {
          title: "Use the Facebook app",
          body: "Instagram uses the same Meta app as Facebook — configure Facebook first.",
        },
        {
          title: "Add Instagram Graph API product",
          body: "In your Meta app dashboard, click <strong>Add Product</strong> → Instagram Graph API.",
        },
        {
          title: "Connect an Instagram Business account",
          body: "Your Instagram account must be a <strong>Professional (Business or Creator)</strong> account linked to a Facebook Page.",
        },
        {
          title: "Add callback URL",
          body: "In Instagram Login settings → Valid OAuth Redirect URIs, paste the callback URL below.",
        },
        {
          title: "No extra env vars needed",
          body: "Instagram and Facebook share <code>FACEBOOK_APP_ID</code> and <code>FACEBOOK_APP_SECRET</code>.",
        },
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
        { name: "THREADS_APP_ID", desc: "App ID", set: !!e.THREADS_APP_ID },
        {
          name: "THREADS_APP_SECRET",
          desc: "App Secret",
          set: !!e.THREADS_APP_SECRET,
        },
      ],
      steps: [
        {
          title: "Create a Meta App",
          body: "Create a Meta Developer app (separate from Facebook/Instagram if you prefer clean separation).",
        },
        {
          title: "Add Threads API product",
          body: "In the app dashboard, click <strong>Add Product</strong> → Threads API.",
        },
        {
          title: "Add callback URL",
          body: "In Threads API settings → Redirect URI, paste the callback URL below.",
        },
        {
          title: "Copy credentials",
          body: "From <strong>App Settings → Basic</strong>, copy App ID and App Secret.",
        },
        {
          title: "Add to Space secrets",
          body: "Add both env vars below to your HF Space settings, then restart.",
        },
      ],
    },
    {
      id: "youtube",
      name: "YouTube",
      emoji: "▶️",
      setupUrl: "https://console.cloud.google.com/apis/credentials",
      docsUrl:
        "https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps",
      callbackUrl: cb("youtube"),
      envVars: [
        {
          name: "YOUTUBE_CLIENT_ID",
          desc: "OAuth 2.0 Client ID",
          set: !!e.YOUTUBE_CLIENT_ID,
        },
        {
          name: "YOUTUBE_CLIENT_SECRET",
          desc: "OAuth 2.0 Client Secret",
          set: !!e.YOUTUBE_CLIENT_SECRET,
        },
      ],
      steps: [
        {
          title: "Create a Google Cloud project",
          body: "Go to Google Cloud Console. Create a new project (or use existing).",
        },
        {
          title: "Enable YouTube Data API v3",
          body: "In APIs & Services → Library, search for <strong>YouTube Data API v3</strong> and enable it.",
        },
        {
          title: "Create OAuth credentials",
          body: "In APIs & Services → Credentials, click <strong>Create Credentials → OAuth client ID</strong>. Set type to <strong>Web application</strong>.",
        },
        {
          title: "Add callback URL",
          body: "Under Authorized redirect URIs, paste the callback URL below.",
        },
        {
          title: "Configure OAuth consent screen",
          body: "Set up consent screen with your app name. Add <strong>YouTube</strong> scopes.",
        },
        {
          title: "Copy credentials",
          body: "Download or copy the <strong>Client ID</strong> and <strong>Client Secret</strong>.",
        },
        {
          title: "Add to Space secrets",
          body: "Add both env vars below to your HF Space settings, then restart.",
        },
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
        {
          name: "TIKTOK_CLIENT_ID",
          desc: "Client Key",
          set: !!e.TIKTOK_CLIENT_ID,
        },
        {
          name: "TIKTOK_CLIENT_SECRET",
          desc: "Client Secret",
          set: !!e.TIKTOK_CLIENT_SECRET,
        },
      ],
      steps: [
        {
          title: "Apply for TikTok Developer access",
          body: "Sign in at developers.tiktok.com. Apply for developer access (may take 1-2 days).",
        },
        {
          title: "Create an app",
          body: "Create a new app. Set <strong>Platform: Web</strong>.",
        },
        {
          title: "Add Login Kit",
          body: "Add <strong>Login Kit</strong> product. This enables OAuth for your app.",
        },
        {
          title: "Add callback URL",
          body: "In Login Kit settings → Redirect domain, add your HF Space hostname. In redirect URI, paste the callback URL below.",
        },
        {
          title: "Request Content Posting API",
          body: "Add <strong>Content Posting API</strong> product for posting videos/photos.",
        },
        {
          title: "Copy credentials",
          body: "From app overview, copy <strong>Client Key</strong> (as CLIENT_ID) and <strong>Client Secret</strong>.",
        },
        {
          title: "Add to Space secrets",
          body: "Add both env vars below to your HF Space settings, then restart.",
        },
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
        {
          name: "REDDIT_CLIENT_ID",
          desc: "Client ID (under app name)",
          set: !!e.REDDIT_CLIENT_ID,
        },
        {
          name: "REDDIT_CLIENT_SECRET",
          desc: "Secret",
          set: !!e.REDDIT_CLIENT_SECRET,
        },
      ],
      steps: [
        {
          title: "Go to Reddit App Preferences",
          body: "Visit reddit.com/prefs/apps while logged in.",
        },
        {
          title: "Create a new app",
          body: "Click <strong>create another app…</strong>. Set type to <strong>web app</strong>.",
        },
        {
          title: "Add callback URL",
          body: "In the <strong>redirect uri</strong> field, paste the callback URL below.",
        },
        {
          title: "Copy credentials",
          body: 'The Client ID is the string below the app name. Client Secret is labelled "secret".',
        },
        {
          title: "Add to Space secrets",
          body: "Add both env vars below to your HF Space settings, then restart.",
        },
      ],
    },
    {
      id: "pinterest",
      name: "Pinterest",
      emoji: "📌",
      setupUrl: "https://developers.pinterest.com/apps/",
      docsUrl:
        "https://developers.pinterest.com/docs/getting-started/set-up-app/",
      callbackUrl: cb("pinterest"),
      envVars: [
        {
          name: "PINTEREST_CLIENT_ID",
          desc: "App ID",
          set: !!e.PINTEREST_CLIENT_ID,
        },
        {
          name: "PINTEREST_CLIENT_SECRET",
          desc: "App Secret",
          set: !!e.PINTEREST_CLIENT_SECRET,
        },
      ],
      steps: [
        {
          title: "Create a Pinterest App",
          body: "Go to Pinterest Developer Portal and create a new app.",
        },
        {
          title: "Add redirect URI",
          body: "In app settings, add the callback URL below as a redirect URI.",
        },
        {
          title: "Request scopes",
          body: "Request <strong>boards:read</strong>, <strong>pins:read</strong>, <strong>pins:write</strong> scopes.",
        },
        {
          title: "Copy credentials",
          body: "Copy App ID and App Secret from the app settings.",
        },
        {
          title: "Add to Space secrets",
          body: "Add both env vars below to your HF Space settings, then restart.",
        },
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
        {
          name: "DISCORD_CLIENT_ID",
          desc: "Application ID",
          set: !!e.DISCORD_CLIENT_ID,
        },
        {
          name: "DISCORD_CLIENT_SECRET",
          desc: "Client Secret",
          set: !!e.DISCORD_CLIENT_SECRET,
        },
        {
          name: "DISCORD_BOT_TOKEN_ID",
          desc: "Bot Token",
          set: !!e.DISCORD_BOT_TOKEN_ID,
        },
      ],
      steps: [
        {
          title: "Create a Discord Application",
          body: "Go to Discord Developer Portal → New Application.",
        },
        {
          title: "Add redirect URL",
          body: "In <strong>OAuth2 → Redirects</strong>, paste the callback URL below.",
        },
        {
          title: "Create a Bot",
          body: "In the <strong>Bot</strong> section, create a bot. Enable <strong>Message Content Intent</strong>.",
        },
        {
          title: "Copy credentials",
          body: "Copy Client ID and Client Secret from OAuth2 tab. Copy Bot Token from Bot tab.",
        },
        {
          title: "Add to Space secrets",
          body: "Add all three env vars below to your HF Space settings, then restart.",
        },
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
        { name: "SLACK_ID", desc: "Client ID", set: !!e.SLACK_ID },
        { name: "SLACK_SECRET", desc: "Client Secret", set: !!e.SLACK_SECRET },
        {
          name: "SLACK_SIGNING_SECRET",
          desc: "Signing Secret",
          set: !!e.SLACK_SIGNING_SECRET,
        },
      ],
      steps: [
        {
          title: "Create a Slack App",
          body: "Go to api.slack.com/apps → Create New App → From scratch.",
        },
        {
          title: "Add OAuth redirect URL",
          body: "In <strong>OAuth & Permissions → Redirect URLs</strong>, paste the callback URL below.",
        },
        {
          title: "Add Bot Token Scopes",
          body: "Under Bot Token Scopes, add: <code>channels:join</code>, <code>chat:write</code>, <code>channels:read</code>, <code>groups:read</code>.",
        },
        {
          title: "Install to workspace",
          body: "Click <strong>Install to Workspace</strong> to generate tokens.",
        },
        {
          title: "Copy credentials",
          body: "From <strong>Basic Information</strong>: App Credentials has Client ID, Client Secret, Signing Secret.",
        },
        {
          title: "Add to Space secrets",
          body: "Add all three env vars below to your HF Space settings, then restart.",
        },
      ],
    },
  ];
}

function renderSetupPage() {
  const spaceHost = process.env.SPACE_HOST || null;
  const spaceId   = process.env.SPACE_ID   || null;
  const publicUrl = spaceHost
    ? `https://${spaceHost}`
    : "http://localhost:7860";
  const settingsUrl = spaceId
    ? `https://huggingface.co/spaces/${spaceId}/settings`
    : "https://huggingface.co/settings/spaces";

  const platforms = getOAuthPlatformDetails(publicUrl);
  const configuredCount = platforms.filter((p) =>
    p.envVars.every((v) => v.set),
  ).length;

  // Build sidebar items
  const sidebarItems = platforms.map((p, i) => {
    const allSet = p.envVars.every((v) => v.set);
    const anySet = p.envVars.some((v) => v.set);
    const dot = allSet
      ? `<span class="dot dot-ok"></span>`
      : anySet
        ? `<span class="dot dot-warn"></span>`
        : `<span class="dot dot-off"></span>`;
    return `<button class="plat-tab${i === 0 ? " active" : ""}" onclick="show(${i})" id="tab-${i}">
      <span class="tab-emoji">${p.emoji}</span>
      <span class="tab-name">${p.name}</span>
      ${dot}
    </button>`;
  }).join("");

  // Build detail panels
  const panels = platforms.map((p, i) => {
    const allSet = p.envVars.every((v) => v.set);
    const anySet = p.envVars.some((v) => v.set);

    const stepsList = p.steps.map((s, si) =>
      `<div class="step">
        <div class="step-num">${si + 1}</div>
        <div>
          <div class="step-title">${s.title}</div>
          <div class="step-body">${s.body}</div>
        </div>
      </div>`
    ).join("");

    const envRows = p.envVars.map((v) =>
      `<div class="env-row">
        <div class="env-info">
          <code class="env-name">${v.name}</code>
          <span class="env-desc">${v.desc}</span>
        </div>
        <div class="env-actions">
          ${v.set
            ? `<span class="badge ok">SET</span>`
            : `<span class="badge off">NOT SET</span>`}
          <button class="btn-copy" onclick="copy('${v.name}',this)">Copy name</button>
        </div>
      </div>`
    ).join("");

    const banner = allSet
      ? `<div class="banner banner-ok">All credentials configured — restart Space if you just added them.</div>`
      : anySet
        ? `<div class="banner banner-warn">Partially configured — add the missing env vars below.</div>`
        : `<div class="banner banner-info">Not yet configured — follow the steps below.</div>`;

    return `<div class="panel${i === 0 ? " active" : ""}" id="panel-${i}">
      <div class="panel-head">
        <span class="panel-emoji">${p.emoji}</span>
        <div>
          <div class="panel-title">${p.name}</div>
          <div class="panel-links">
            <a href="${p.setupUrl}" target="_blank" rel="noopener">Open Developer Portal →</a>
            ${p.docsUrl ? `<a href="${p.docsUrl}" target="_blank" rel="noopener">Official Docs →</a>` : ""}
          </div>
        </div>
      </div>

      ${banner}

      <div class="section-label">Setup Steps</div>
      <div class="steps-list">${stepsList}</div>

      <div class="section-label">Callback URL
        <span class="section-hint">Paste this in the developer portal when asked for "Redirect URI" or "Callback URL"</span>
      </div>
      <div class="copy-block">
        <span class="copy-block-text">${p.callbackUrl}</span>
        <button class="btn-copy btn-copy-accent" onclick="copy('${p.callbackUrl}',this)">Copy</button>
      </div>

      <div class="section-label">Space Secrets to Add
        <span class="section-hint">HF Space → Settings → Variables &amp; Secrets</span>
      </div>
      <div class="env-list">${envRows}</div>

      <a href="${settingsUrl}" target="_blank" rel="noopener" class="settings-btn">
        Open Space Settings → Variables &amp; Secrets
      </a>
      <p class="hint-final">After adding all secrets, click <strong>Restart Space</strong> for them to take effect.</p>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Platform Setup — HuggingPost</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  color-scheme: dark;
  --bg:     #08080f;
  --panel:  #12111b;
  --panel2: #151421;
  --line:   #26243a;
  --text:   #f6f4ff;
  --muted:  #7f7a9e;
  --soft:   #b8b3d7;
  --good:   #22c55e;
  --warn:   #f5c542;
  --bad:    #fb7185;
  --accent: #3b82f6;
  --accent2:#8b5cf6;
}
body {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Top bar ─────────────────────────────────────────── */
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px;
  height: 48px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  flex-shrink: 0;
}
.topbar-back {
  color: var(--muted);
  text-decoration: none;
  font-size: .78rem;
  font-weight: 700;
  letter-spacing: .04em;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color .15s;
}
.topbar-back:hover { color: var(--text); }
.topbar-title {
  font-size: .78rem;
  font-weight: 850;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--soft);
}
.topbar-count {
  margin-left: auto;
  font-size: .72rem;
  font-weight: 850;
  color: var(--muted);
  letter-spacing: .08em;
  text-transform: uppercase;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 10px;
}

/* ── Layout ──────────────────────────────────────────── */
.layout { display: flex; flex: 1; overflow: hidden; }

/* ── Sidebar ─────────────────────────────────────────── */
.sidebar {
  width: 210px;
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--line);
  overflow-y: auto;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sidebar-label {
  font-size: .62rem;
  font-weight: 850;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 6px 10px 10px;
}
.plat-tab {
  width: 100%;
  background: none;
  border: none;
  color: var(--soft);
  font: inherit;
  font-size: .82rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: background .12s, color .12s;
  border: 1px solid transparent;
}
.plat-tab:hover { background: var(--panel2); color: var(--text); }
.plat-tab.active {
  background: var(--panel2);
  color: var(--text);
  border-color: var(--line);
}
.tab-emoji { font-size: .95rem; width: 20px; text-align: center; flex-shrink: 0; }
.tab-name  { flex: 1; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot-ok   { background: var(--good); }
.dot-warn { background: var(--warn); }
.dot-off  { background: var(--line); }

/* ── Main panel ──────────────────────────────────────── */
.main { flex: 1; overflow-y: auto; padding: 28px 32px; max-width: 780px; }
.panel { display: none; animation: fadein .18s ease; }
.panel.active { display: block; }
@keyframes fadein { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }

.panel-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 18px;
}
.panel-emoji { font-size: 2.2rem; flex-shrink: 0; line-height: 1; }
.panel-title { font-size: 1.4rem; font-weight: 850; margin-bottom: 6px; }
.panel-links { display: flex; gap: 14px; flex-wrap: wrap; }
.panel-links a {
  color: var(--accent2);
  font-size: .76rem;
  font-weight: 700;
  text-decoration: none;
  letter-spacing: .02em;
}
.panel-links a:hover { text-decoration: underline; }

/* Banner */
.banner {
  padding: 10px 14px;
  border-radius: 8px;
  font-size: .8rem;
  font-weight: 600;
  margin-bottom: 20px;
  border: 1px solid transparent;
}
.banner-ok   { background: rgba(34,197,94,.08);  border-color: rgba(34,197,94,.22);  color: #86efac; }
.banner-warn { background: rgba(245,197,66,.08); border-color: rgba(245,197,66,.22); color: #fde68a; }
.banner-info { background: rgba(59,130,246,.08); border-color: rgba(59,130,246,.22); color: #93c5fd; }

/* Section labels */
.section-label {
  font-size: .62rem;
  font-weight: 850;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 22px 0 10px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.section-hint {
  font-size: .7rem;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: var(--muted);
  opacity: .7;
}

/* Steps */
.steps-list { display: flex; flex-direction: column; gap: 4px; }
.step {
  display: flex;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
}
.step-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: .68rem;
  font-weight: 850;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}
.step-title { font-size: .82rem; font-weight: 800; margin-bottom: 3px; color: var(--text); }
.step-body  { font-size: .78rem; color: var(--soft); line-height: 1.6; }
.step-body strong { color: var(--text); font-weight: 800; }
.step-body code {
  background: var(--panel2);
  border: 1px solid var(--line);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: .85em;
  color: var(--text);
}
.step-body a { color: var(--accent2); text-decoration: none; }
.step-body a:hover { text-decoration: underline; }

/* Callback copy block */
.copy-block {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 11px 14px;
}
.copy-block-text {
  flex: 1;
  font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace;
  font-size: .78rem;
  color: var(--accent2);
  word-break: break-all;
  opacity: .9;
}

/* Env var rows */
.env-list { display: flex; flex-direction: column; gap: 5px; }
.env-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.env-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.env-name {
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: .78rem;
  color: var(--accent2);
  background: rgba(139,92,246,.12);
  border: 1px solid rgba(139,92,246,.2);
  padding: 2px 7px;
  border-radius: 5px;
  width: fit-content;
}
.env-desc { font-size: .72rem; color: var(--muted); }
.env-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: .66rem;
  font-weight: 850;
  letter-spacing: .06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.badge.ok  { color: var(--good); border-color: rgba(34,197,94,.3);  background: rgba(34,197,94,.1);  }
.badge.off { color: var(--bad);  border-color: rgba(251,113,133,.3); background: rgba(251,113,133,.1); }

/* Buttons */
.btn-copy {
  background: var(--panel2);
  border: 1px solid var(--line);
  color: var(--soft);
  font: inherit;
  font-size: .72rem;
  font-weight: 700;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background .12s, color .12s;
  flex-shrink: 0;
  white-space: nowrap;
}
.btn-copy:hover { background: var(--line); color: var(--text); }
.btn-copy.copied { background: rgba(34,197,94,.12); border-color: rgba(34,197,94,.3); color: var(--good); }
.btn-copy-accent {
  background: rgba(59,130,246,.12);
  border-color: rgba(59,130,246,.3);
  color: #93c5fd;
  font-size: .76rem;
  padding: 6px 14px;
}
.btn-copy-accent:hover { background: rgba(59,130,246,.2); }

/* Settings CTA */
.settings-btn {
  display: inline-flex;
  align-items: center;
  margin-top: 16px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  text-decoration: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: .82rem;
  font-weight: 850;
  transition: opacity .15s;
}
.settings-btn:hover { opacity: .85; }
.hint-final {
  margin-top: 10px;
  font-size: .74rem;
  color: var(--muted);
  line-height: 1.5;
  padding-bottom: 32px;
}
.hint-final strong { color: var(--soft); }

/* Mobile */
@media (max-width: 680px) {
  body { overflow: auto; height: auto; }
  .layout { flex-direction: column; overflow: visible; }
  .sidebar {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--line);
    flex-direction: row;
    flex-wrap: wrap;
    overflow-x: auto;
    padding: 8px;
    gap: 4px;
  }
  .sidebar-label { display: none; }
  .plat-tab { width: auto; flex: 0 0 auto; }
  .tab-name { display: none; }
  .main { padding: 16px; }
}
</style>
</head>
<body>
<div class="topbar">
  <a class="topbar-back" href="/">← Dashboard</a>
  <span class="topbar-title">Platform Setup Guide</span>
  <span class="topbar-count">${configuredCount} / ${platforms.length} configured</span>
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
const PLATFORM_IDS = ${JSON.stringify(platforms.map((p) => p.id))};
function show(i) {
  document.querySelectorAll('.plat-tab').forEach((t,j)=>t.classList.toggle('active',j===i));
  document.querySelectorAll('.panel').forEach((p,j)=>p.classList.toggle('active',j===i));
  if(PLATFORM_IDS[i]) history.replaceState(null,'','#'+PLATFORM_IDS[i]);
}
function copy(text,btn) {
  const finish = () => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(()=>{ btn.textContent=orig; btn.classList.remove('copied'); },1800);
  };
  if(navigator.clipboard) { navigator.clipboard.writeText(text).then(finish).catch(fallback); }
  else fallback();
  function fallback() {
    const ta=document.createElement('textarea');
    ta.value=text; ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy');}catch{}
    document.body.removeChild(ta); finish();
  }
}
(function(){
  const hash=location.hash.replace('#','').toLowerCase();
  if(hash){const idx=PLATFORM_IDS.indexOf(hash);if(idx!==-1)show(idx);}
})();
</script>
</body>
</html>`;
}

// ============================================================================
// URL helpers
// ============================================================================

function parseRequestUrl(url) {
  try {
    return new URL(url, "http://localhost");
  } catch {
    return new URL("http://localhost/");
  }
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
      return JSON.parse(
        fs.readFileSync(CLOUDFLARE_KEEPALIVE_STATUS_FILE, "utf8"),
      );
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

function renderTile({
  title,
  value,
  detail = "",
  tone = "neutral",
  meta = "",
}) {
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
      db_status: "unknown",
      last_sync_time: null,
      last_error: null,
      sync_count: 0,
      status: "configured",
      message: `Backup enabled. Waiting for first sync (every ${SYNC_INTERVAL}s).`,
    };
  }
  return {
    db_status: "unknown",
    last_sync_time: null,
    last_error: null,
    sync_count: 0,
  };
}

function checkPostizHealth() {
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => resolve({ status: "unreachable", reason: "timeout" }),
      5000,
    );
    http
      .get(`http://${POSTIZ_HOST}:${POSTIZ_PORT}/`, (res) => {
        clearTimeout(timeout);
        resolve({
          status: res.statusCode < 500 ? "running" : "error",
          statusCode: res.statusCode,
        });
        res.resume();
      })
      .on("error", (err) => {
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
  const syncTone = ["success", "restored", "synced", "configured"].includes(
    syncStatus,
  )
    ? "ok"
    : syncStatus === "disabled"
      ? "warn"
      : "neutral";
  const backupDetail = data.sync?.message
    ? escapeHtml(data.sync.message)
    : "No status yet";

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
    : keepaliveStatus === "error" && data.keepalive?.message
      ? escapeHtml(data.keepalive.message)
      : process.env.CLOUDFLARE_WORKERS_TOKEN
        ? "Worker pending or failed"
        : "Not configured";

  const platforms = getSocialPlatforms();
  const readyNow = platforms.filter((p) => p.noOAuth);
  const needsSetup = platforms.filter((p) => !p.noOAuth);
  const configuredCount = needsSetup.filter((p) => p.ready).length;

  const needsSetupRows = needsSetup
    .map((p) => {
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
    })
    .join("");

  const readyNowRows = readyNow
    .map(
      (p) => `
    <div class="plat-row ready">
      <span class="plat-icon">${p.emoji}</span>
      <span class="plat-name">${p.name}</span>
      <span style="font-size:0.75rem;color:var(--dim)">${p.note || ""}</span>
    </div>`,
    )
    .join("");

  const tiles = [
    renderTile({
      title: "Postiz Core",
      value: toneBadge(
        data.postizRunning ? "Online" : "Booting",
        data.postizRunning ? "ok" : "warn",
      ),
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
      meta: data.sync?.timestamp
        ? `<span class="local-time" data-iso="${data.sync.timestamp}"></span>`
        : "",
    }),
    renderTile({
      title: "Keep Awake",
      value: toneBadge(
        keepaliveConfigured ? "CF Cron" : keepaliveStatus.toUpperCase(),
        keepAliveTone,
      ),
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

    ${
      data.postizRunning
        ? `<a href="/app/auth" class="hero-action" target="_blank" rel="noopener">Open Postiz -></a>`
        : `<a href="#" class="hero-action booting" onclick="return false">Postiz is starting up (first boot ~5 min)...</a>`
    }

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

    <footer>Built by <a href="https://github.com/somratpro" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: none;">@somratpro</a></footer>
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
    document.querySelectorAll('.local-time').forEach(el => {
      const date = new Date(el.getAttribute('data-iso'));
      if (!isNaN(date)) {
        el.textContent = 'At ' + date.toLocaleTimeString();
      }
    });
  </script>
</body>
</html>`;
}

// ============================================================================
// Reverse proxy
// ============================================================================

function buildProxyHeaders(headers) {
  const f = headers["x-forwarded-for"];
  const clientIp =
    typeof f === "string"
      ? f.split(",")[0].trim()
      : Array.isArray(f) && f.length
        ? String(f[0]).split(",")[0].trim()
        : "";
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
    {
      hostname: POSTIZ_HOST,
      port: POSTIZ_PORT,
      method: req.method,
      path: targetPath,
      headers: buildProxyHeaders(req.headers),
    },
    (proxyRes) => {
      upstreamStarted = true;
      // Rewrite Location headers: add /app basePath if missing, convert
      // internal-host absolute URLs to relative paths.
      const outHeaders = Object.assign({}, proxyRes.headers);
      const fixedLoc = rewriteLocation(outHeaders["location"]);
      if (fixedLoc !== outHeaders["location"])
        outHeaders["location"] = fixedLoc;
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    if (res.headersSent || upstreamStarted) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "error",
        message: "Postiz unavailable",
        detail: error.message,
        hint: "Postiz may still be starting (first boot ~60s after build). Check the Logs tab.",
      }),
    );
  });
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, overridePath) {
  const targetPath = overridePath !== undefined ? overridePath : req.url;
  const proxySocket = net.connect(POSTIZ_PORT, POSTIZ_HOST);
  proxySocket.on("connect", () => {
    const f = req.headers["x-forwarded-for"];
    const clientIp =
      typeof f === "string"
        ? f.split(",")[0].trim()
        : req.socket.remoteAddress || "";
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
      "",
      "",
    ];
    proxySocket.write(lines.join("\r\n"));
    if (head && head.length > 0) proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });
  proxySocket.on("error", () => {
    if (socket.writable)
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
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
    res.end(
      JSON.stringify({
        status: "ok",
        uptime,
        uptimeHuman: formatUptime(uptime),
        timestamp: new Date().toISOString(),
        sync: readSyncStatus(),
      }),
    );
    return;
  }

  // ── /status ──────────────────────────────────────────────────────────────
  if (pathname === "/status") {
    void (async () => {
      const postiz = await checkPostizHealth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          uptime: formatUptime(uptime),
          postizRunning: postiz.status === "running",
          sync: readSyncStatus(),
          keepalive: getKeepaliveStatus(),
        }),
      );
    })();
    return;
  }

  // ── /setup — OAuth platform setup wizard ─────────────────────────────────
  if (pathname === "/setup" || pathname === "/setup/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSetupPage());
    return;
  }

  // ── /app/redeploy-cf-worker — force Cloudflare Worker redeploy ───────────
  // Strips CLOUDFLARE_PROXY_URL from subprocess env so the setup script
  // bypasses the short-circuit and deploys the updated Worker template.
  if (pathname === "/app/redeploy-cf-worker") {
    const { execFile } = require("child_process");
    const subEnv = { ...process.env };
    delete subEnv.CLOUDFLARE_PROXY_URL;
    delete subEnv.CLOUDFLARE_PROXY_SECRET;
    execFile("python3", ["/opt/postiz-sync.py", "--version"], { env: subEnv }, () => {}); // no-op warm-up
    execFile("python3", ["/opt/cloudflare-proxy-setup.py"], { env: subEnv, timeout: 60000 },
      (err, stdout, stderr) => {
        const lines = [
          "Redeploying Cloudflare Worker with updated template...",
          "",
          "=== stdout ===",
          stdout || "(empty)",
          "=== stderr ===",
          stderr || "(empty)",
          err ? "=== exec error ===\n" + err.message : "=== done ===",
          "",
          "Worker updated. Try connecting X now.",
        ];
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(lines.join("\n"));
      }
    );
    return;
  }

  // ── /app/test-twitter — raw connectivity probe to api.twitter.com ────────
  if (pathname === "/app/test-twitter") {
    const https = require("https");
    const lines = [];
    lines.push(`NODE_OPTIONS         : ${process.env.NODE_OPTIONS || "(not set)"}`);
    lines.push(`CLOUDFLARE_PROXY_URL : ${process.env.CLOUDFLARE_PROXY_URL || "(not set)"}`);
    lines.push("");
    // Two probes:
    //   A) GET api.twitter.com/ — basic reachability + proxy detection
    //   B) POST oauth/access_token (no auth) — 4xx+JSON if IP allowed, 500 HTML if IP blocked
    const makeProbe = (opts, postBody) => new Promise((resolve) => {
      const t0 = Date.now();
      const req = https.request({ ...opts, timeout: 10000 }, (r) => {
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (c) => { body += c; if (body.length > 800) r.destroy(); });
        r.on("close", () => resolve({ status: r.statusCode, headers: r.headers, body: body.trim(), ms: Date.now() - t0 }));
        r.on("end",  () => resolve({ status: r.statusCode, headers: r.headers, body: body.trim(), ms: Date.now() - t0 }));
      });
      req.on("error",   (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
      req.on("timeout", () => { req.destroy(); resolve({ error: "TIMEOUT 10s", ms: Date.now() - t0 }); });
      if (postBody) req.write(postBody);
      req.end();
    });

    (async () => {
      // Probe A
      lines.push("── Probe A: GET https://api.twitter.com/ ──");
      const a = await makeProbe({ hostname: "api.twitter.com", path: "/", method: "GET",
        headers: { "User-Agent": "curl/8.0", "Accept": "*/*" } });
      if (a.error) {
        lines.push(`ERROR: ${a.error}`);
      } else {
        lines.push(`Status : ${a.status}  (${a.ms}ms)`);
        for (const [k, v] of Object.entries(a.headers)) lines.push(`  ${k}: ${v}`);
        lines.push(`cf-ray in headers? : ${a.headers["cf-ray"] ? "YES → request went through Cloudflare" : "no"}`);
        lines.push(`Body (first 300)   : ${a.body.slice(0, 300)}`);
      }

      // Probe B
      lines.push("");
      lines.push("── Probe B: POST https://api.twitter.com/oauth/access_token (no auth) ──");
      lines.push("Expected: 400/401 JSON if IP allowed by X, 500 HTML if IP blocked");
      const postBody = "oauth_verifier=test";
      const b = await makeProbe({ hostname: "api.twitter.com", path: "/oauth/access_token",
        method: "POST",
        headers: { "User-Agent": "curl/8.0", "Content-Type": "application/x-www-form-urlencoded",
                   "Content-Length": Buffer.byteLength(postBody) } }, postBody);
      if (b.error) {
        lines.push(`ERROR: ${b.error}`);
      } else {
        lines.push(`Status : ${b.status}  (${b.ms}ms)`);
        for (const [k, v] of Object.entries(b.headers)) lines.push(`  ${k}: ${v}`);
        const isHtml = b.body.includes("<html") || b.body.includes("<!DOCTYPE");
        lines.push(`Body type : ${isHtml ? "HTML ← IP probably blocked" : "text/JSON ← IP allowed"}`);
        lines.push(`Body (first 500) : ${b.body.slice(0, 500)}`);
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(lines.join("\n"));
    })();
    return;
  }

  // ── /app/debug-logs — Temporary endpoint for debugging ───────────────────
  if (pathname === "/app/debug-logs") {
    try {
      // tail helper — last N lines of a file
      const tailLines = (path, n) => {
        if (!fs.existsSync(path)) return `(no file: ${path})`;
        const lines = fs.readFileSync(path, "utf8").split("\n");
        return lines.slice(-n).join("\n");
      };

      const errLog = tailLines("/root/.pm2/logs/backend-error.log", 150);
      const outLog = tailLines("/root/.pm2/logs/backend-out.log", 80);

      // masked credential diagnostics — first 6 chars + length
      const maskCred = (val) => {
        if (!val) return "(not set)";
        const clean = val.trim();
        if (clean.length === 0) return "(empty)";
        return `${clean.slice(0, 6)}... (len=${clean.length})`;
      };
      const xKey    = maskCred(process.env.X_API_KEY);
      const xSecret = maskCred(process.env.X_API_SECRET);
      const frontendUrl = process.env.FRONTEND_URL || "(not set)";

      // Heuristic: X Consumer Key is ~25 alphanum, Consumer Secret ~50 alphanum.
      // OAuth 2.0 Client ID is base64url and usually longer (36+).
      const xKeyNote = (() => {
        const v = (process.env.X_API_KEY || "").trim();
        if (!v) return "MISSING";
        if (v.length > 35) return "⚠ LOOKS LIKE OAuth2 CLIENT ID (too long) — should be ~25 chars";
        if (v.includes("=") || v.includes(":")) return "⚠ LOOKS WRONG (contains = or :)";
        return "✓ length ok";
      })();
      const xSecretNote = (() => {
        const v = (process.env.X_API_SECRET || "").trim();
        if (!v) return "MISSING";
        if (v.length < 40) return "⚠ TOO SHORT — Consumer Secret is ~50 chars";
        if (v.length > 70) return "⚠ TOO LONG — might be OAuth2 Client Secret or Access Token Secret";
        if (v.includes("=")) return "⚠ CONTAINS = — might be base64 encoded (wrong key type)";
        return "✓ length ok";
      })();

      const credSection = [
        "=== X CREDENTIAL CHECK ===",
        `X_API_KEY    : ${xKey}  [${xKeyNote}]`,
        `X_API_SECRET : ${xSecret}  [${xSecretNote}]`,
        `FRONTEND_URL : ${frontendUrl}`,
        `Expected callback URL: ${frontendUrl}/integrations/social/x`,
      ].join("\n");

      const cfProxyLog = fs.existsSync("/tmp/huggingpost-cloudflare-proxy.env")
        ? fs.readFileSync("/tmp/huggingpost-cloudflare-proxy.env", "utf8").replace(/(SECRET|TOKEN)=\S+/gi, "$1=(redacted)")
        : "(file not found — proxy not deployed; CLOUDFLARE_WORKERS_TOKEN not set?)";

      const cfProxySection = [
        "=== CLOUDFLARE PROXY STATUS ===",
        `CLOUDFLARE_WORKERS_TOKEN : ${process.env.CLOUDFLARE_WORKERS_TOKEN ? "✓ set (len=" + process.env.CLOUDFLARE_WORKERS_TOKEN.length + ")" : "✗ NOT SET — proxy never deployed, X traffic goes direct"}`,
        `CLOUDFLARE_PROXY_URL     : ${process.env.CLOUDFLARE_PROXY_URL ? maskCred(process.env.CLOUDFLARE_PROXY_URL) : "✗ NOT SET — api.twitter.com calls NOT proxied"}`,
        `CLOUDFLARE_PROXY_DEBUG   : ${process.env.CLOUDFLARE_PROXY_DEBUG || "(not set)"}`,
        `NODE_OPTIONS             : ${process.env.NODE_OPTIONS || "(not set — cloudflare-proxy.js NOT loaded in backend!)"}`,
        `/opt/cloudflare-proxy.js : ${fs.existsSync("/opt/cloudflare-proxy.js") ? "✓ exists" : "✗ MISSING"}`,
        `/tmp/huggingpost-cloudflare-proxy.env contents:`,
        cfProxyLog,
        `cf-proxy-banner-shown    : ${fs.existsSync("/tmp/.cf-proxy-banner-shown") ? "✓ (proxy init ran at least once)" : "(not found)"}`,
      ].join("\n");

      const xCallbackLog = fs.existsSync("/tmp/x-oauth-callbacks.log")
        ? fs.readFileSync("/tmp/x-oauth-callbacks.log", "utf8")
        : "(no X callbacks recorded yet — try adding X channel now)";

      // Redis check: look up login:* keys and verify codeVerifier structure.
      // Root cause check: oauth_token_secret must be present after split on ':'.
      let redisSection = "=== REDIS codeVerifier CHECK ===\n";
      try {
        const { execSync } = require("child_process");
        const rc = (cmd) => { try { return execSync(cmd, { timeout: 5000 }).toString().trim(); } catch(e) { return "(err: " + e.message.slice(0,60) + ")"; } };

        const keyspace = rc("redis-cli -h 127.0.0.1 -p 6379 info keyspace 2>/dev/null");
        redisSection += `Redis keyspace:\n${keyspace || "(empty)"}\n\n`;

        // Check DB 0 (default) and DB 1 for all keys
        // Also inspect external:* keys — Postiz stores codeVerifier under external:{oauth_token}
        const inspectKeys = (db, pattern) => {
          const dbFlag = db === 0 ? "" : `-n ${db}`;
          const keys = rc(`redis-cli -h 127.0.0.1 -p 6379 ${dbFlag} keys "${pattern}" 2>/dev/null`);
          if (!keys || keys.startsWith("(")) return `  ${pattern}: (none)\n`;
          let out = `  ${pattern} keys found:\n`;
          for (const key of keys.split("\n").filter(Boolean).slice(0, 5)) {
            const val = rc(`redis-cli -h 127.0.0.1 -p 6379 ${dbFlag} get "${key}" 2>/dev/null`);
            const ttl = rc(`redis-cli -h 127.0.0.1 -p 6379 ${dbFlag} ttl "${key}" 2>/dev/null`);
            if (!val) { out += `    ${key}: EMPTY! [TTL=${ttl}]\n`; continue; }
            const colonIdx = val.indexOf(":");
            const token  = colonIdx > 0 ? val.slice(0, colonIdx) : "";
            const secret = colonIdx > 0 ? val.slice(colonIdx + 1) : "";
            const extraColons = (val.match(/:/g) || []).length - 1;
            const note = colonIdx < 0 ? "⚠ NO COLON" : extraColons > 0 ? `⚠ ${extraColons} extra colon(s)` : secret.length < 30 ? "⚠ secret short" : "✓ ok";
            out += `    ${key} [TTL=${ttl}s]\n      token: ${token.slice(0,12)}... (len=${token.length})\n      secret: ${secret.slice(0,12)}... (len=${secret.length})\n      note: ${note}\n`;
          }
          return out;
        };

        for (const db of [0, 1, 2]) {
          const dbFlag = db === 0 ? "" : `-n ${db}`;
          const allKeys = rc(`redis-cli -h 127.0.0.1 -p 6379 ${dbFlag} keys "*" 2>/dev/null`);
          redisSection += `DB ${db}: total keys preview: ${allKeys ? allKeys.split("\n").slice(0,8).join(", ") : "(none)"}\n`;
          redisSection += inspectKeys(db, "login:*");
          redisSection += inspectKeys(db, "external:*");
          redisSection += "\n";
        }
      } catch (e) {
        redisSection += `(redis-cli error: ${e.message})`;
      }

      const out = [
        credSection,
        "",
        cfProxySection,
        "",
        "=== X OAUTH CALLBACKS (from health-server) ===",
        xCallbackLog,
        "",
        redisSection,
        "",
        "=== BACKEND ERROR LOG (last 150 lines) ===",
        errLog,
        "",
        "=== BACKEND OUT LOG (last 80 lines) ===",
        outLog,
      ].join("\n");
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
        keepalive: getKeepaliveStatus(),
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
    res.writeHead(302, {
      Location: "/app/launches/" + (parsedUrl.search || ""),
    });
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
    res.writeHead(301, {
      Location: "/app" + pathname + (parsedUrl.search || ""),
    });
    res.end();
    return;
  }

  // ── Anything else → redirect to /app<path> ──────────────────────────────
  // After login, Postiz's client-side router may navigate to a path without
  // the /app basePath prefix (e.g. /launches, /analytics, /api/...).
  // Redirect those here rather than 404-ing so the browser lands correctly.

  // Log OAuth callbacks for debugging.
  if (pathname === "/integrations/social/x") {
    const oauthToken    = parsedUrl.searchParams.get("oauth_token")    || "(missing)";
    const oauthVerifier = parsedUrl.searchParams.get("oauth_verifier") || "(MISSING!)";
    const denied        = parsedUrl.searchParams.get("denied");
    const ts = new Date().toISOString();
    const msg = denied
      ? `[${ts}] X OAuth DENIED — denied=${denied}`
      : `[${ts}] X OAuth callback — oauth_token=${oauthToken.slice(0,20)}... oauth_verifier=${oauthVerifier === "(MISSING!)" ? "(MISSING! — X did not send verifier)" : oauthVerifier.slice(0,10) + "... (present ✓)"}`;
    console.log(msg);
    // Append to a file the debug-logs endpoint can read.
    try {
      fs.appendFileSync("/tmp/x-oauth-callbacks.log", msg + "\n");
    } catch(_) {}
  }

  res.writeHead(302, {
    Location: "/app" + pathname + (parsedUrl.search || ""),
  });
  res.end();
});

server.on("upgrade", (req, socket, head) => {
  const parsedUrl = parseRequestUrl(req.url || "/");
  const pathname = parsedUrl.pathname;
  if (isLocalRoute(pathname)) {
    socket.destroy();
    return;
  }
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
  console.log(
    `✓ Postiz    : http://localhost:${PORT}/app/  → nginx :${POSTIZ_PORT}`,
  );
});
