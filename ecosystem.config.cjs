// PM2 process config for the sc-bridge backend (serve.mjs).
//
// serve.mjs runs the `sc` (simple-ai-chat) CLI behind HTTP/SSE so the published
// glasses app can reach it.
//
// Usage:
//   pm2 start ecosystem.config.cjs        # start
//   pm2 restart ecosystem.config.cjs      # restart after a deploy
//   pm2 logs "$PM2_NAME"                  # tail logs (default: sc-bridge)
//   pm2 save && pm2 startup               # persist across reboots
//
// Env vars serve.mjs reads (see its header): PORT, SC_CMD, SC_ALLOW_ORIGIN,
// SC_SESSION_TTL, OPENAI_API_KEY (required for /api/transcribe).
//
// PORT and PM2_NAME come from .env. They're read here rather than left to
// --env-file because PM2's own `env` block lands in the process environment
// first, and Node's --env-file does not override what's already set there —
// so .env has to be consulted at config time to stay the single source of truth.

const fs = require("fs");
const path = require("path");

function readEnv() {
  try {
    return fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  } catch {
    return "";
  }
}

function getEnvVar(key, defaultValue) {
  const match = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : defaultValue;
}

const PORT = getEnvVar("PORT", "8787");
const PM2_NAME = getEnvVar("PM2_NAME", "sc-bridge");

module.exports = {
  apps: [
    {
      name: PM2_NAME,
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
        PORT: PORT,
        // SC_ALLOW_ORIGIN: "*",
        // SC_SESSION_TTL: 120000,
        // OPENAI_API_KEY: "sk-...",  // set this in the server environment or a .env file
      },
      time: true, // prefix log lines with timestamps
      out_file: `logs/${PM2_NAME}.out.log`,
      error_file: `logs/${PM2_NAME}.err.log`,
      merge_logs: true,
    },
  ],
};
