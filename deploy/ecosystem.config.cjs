module.exports = {
  apps: [
    {
      name: "clawme-backend",
      script: "/opt/clawme/backend/dist/index.js",
      cwd: "/opt/clawme/backend",
      env: {
        NODE_ENV: "production",
        PORT: 31871,
        // Credentials. The relay refuses to start without one of these, on
        // purpose: this config normally sits behind a public Cloudflare tunnel,
        // and a relay that authenticates nobody authenticates everybody.
        // setup.sh generates a random token into /etc/clawme/token and passes
        // it through the environment, so this stays out of version control.
        CLAWME_TOKENS: process.env.CLAWME_TOKENS,
        // CLAWME_IDENTITIES: '{"<token>":{"actor_id":"phone-1","actor_kind":"device","surface":"android","role":"controller"}}',
        //
        // Bind address. Loopback by default; the tunnel reaches it locally.
        // CLAWME_BIND: "0.0.0.0",
        //
        // AI: set CLAWME_AI_API_KEY on server (e.g. via .env or PM2 env)
        // CLAWME_AI_BASE_URL: "https://api.deepseek.com/v1",
        // CLAWME_AI_MODEL: "deepseek-chat",
        // CLAWME_AI_PROVIDER: "openai",  // "openai" or "anthropic"
        // OPENCLAW_HOOK_URL: "http://your-openclaw:port/hooks/agent",
        // OPENCLAW_HOOK_TOKEN: "your-openclaw-hook-token",
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: "200M",
    },
    {
      name: "clawme-tunnel",
      script: "/usr/local/bin/cloudflared",
      args: "tunnel --url http://127.0.0.1:31871",
      autorestart: true,
      max_memory_restart: "100M",
    },
  ],
};
