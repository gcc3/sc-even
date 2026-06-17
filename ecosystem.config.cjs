// PM2 process config for the sc-bridge backend (serve.mjs).
//
// serve.mjs runs the `sc` (simple-ai-chat) CLI behind HTTP/SSE so the published
// glasses app can reach it. The app talks to a fixed host (see SC_SERVER_BASE_URL
// in src/utils/scUtils.ts: http://159.223.204.39:8787/), so this listens on 8787.
//
// Usage:
//   pm2 start ecosystem.config.cjs        # start
//   pm2 restart ecosystem.config.cjs      # restart after a deploy
//   pm2 logs sc-bridge                    # tail logs
//   pm2 save && pm2 startup               # persist across reboots
//
// Env vars serve.mjs reads (see its header): PORT, SC_CMD, SC_ALLOW_ORIGIN,
// SC_SESSION_TTL, OPENAI_API_KEY (required for /api/transcribe).

module.exports = {
  apps: [
    {
      name: "sc-bridge",
      script: "serve.mjs",
      node_args: "--env-file=.env",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork", // SSE + per-session child sc processes — single instance only
      autorestart: true,
      max_restarts: 10,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 8787,
        // SC_ALLOW_ORIGIN: "*",
        // SC_SESSION_TTL: 120000,
        // OPENAI_API_KEY: "sk-...",  // set this in the server environment or a .env file
      },
      time: true, // prefix log lines with timestamps
      out_file: "logs/sc-bridge.out.log",
      error_file: "logs/sc-bridge.err.log",
      merge_logs: true,
    },
  ],
};
