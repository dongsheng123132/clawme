module.exports = {
  apps: [
    {
      name: "clawme-backend",
      script: "/opt/clawme/backend/dist/index.js",
      cwd: "/opt/clawme/backend",
      env: {
        NODE_ENV: "production",
        PORT: 31871,
        // AI: set CLAWME_AI_API_KEY on server (e.g. via .env or PM2 env)
        // CLAWME_AI_BASE_URL: "https://api.deepseek.com/v1",
        // CLAWME_AI_MODEL: "deepseek-chat",
        // CLAWME_AI_PROVIDER: "openai",  // "openai" or "anthropic"
        // CLAWME_TOKENS: "your-token-1,your-token-2",
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
