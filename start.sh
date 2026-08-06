#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Production launcher: runs the sc-bridge backend (serve.mjs) under PM2 using
# ecosystem.config.cjs, so it stays up across crashes and reboots.
#
# For local frontend development (Vite dev server + QR for the glasses), use
# ./develop.sh instead.
#
# Usage:
#   ./start.sh                 # start (or reload) the sc-bridge under PM2
#
# After the first run, persist across reboots with:
#   pm2 save && pm2 startup

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. Install Node.js first." >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found on PATH. Install it with: npm install -g pm2" >&2
  exit 1
fi

# serve.mjs spawns the `sc` (simple-ai-chat) CLI per session; make sure deps are
# installed before PM2 launches it (PM2 runs serve.mjs directly, so unlike
# serve.sh it won't install them on demand).
if [ ! -x "node_modules/.bin/sc" ]; then
  echo "==> sc CLI not found — installing dependencies"
  npm ci || npm install
fi

# startOrReload is idempotent: starts the app if it's not running, otherwise
# reloads it in place — so re-running this after a deploy just redeploys.
pm2 startOrReload ecosystem.config.cjs

# Name and port live in .env (see .env.example); ecosystem.config.cjs reads the
# same two values, these are only for the summary below.
PM2_NAME="$(grep -m1 '^PM2_NAME=' .env 2>/dev/null | cut -d= -f2- || true)"
PORT="$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2- || true)"

pm2 list
echo
echo "==> ${PM2_NAME:-sc-bridge} is running under PM2 on port ${PORT:-8787}."
echo "    Logs:    pm2 logs ${PM2_NAME:-sc-bridge}"
echo "    Persist: pm2 save && pm2 startup"
