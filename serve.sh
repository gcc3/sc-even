#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Serves the sc-bridge backend (serve.mjs): runs the `sc` (simple-ai-chat) CLI
# behind HTTP/SSE so the glasses app can reach it. One sc process per session —
# see serve.mjs for the env vars it accepts.
#
# Usage:
#   ./serve.sh                      # http://localhost:8787 (+ detected public URL)
#   PORT=9000 ./serve.sh            # custom port
#   PUBLIC_HOST=1.2.3.4 ./serve.sh  # force the host shown in the public URL

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. Install Node.js first." >&2
  exit 1
fi

# The sc CLI ships as a dependency; install if it's missing.
if [ ! -x "node_modules/.bin/sc" ]; then
  echo "==> sc CLI not found — installing dependencies"
  npm install
fi

# PORT: explicit env wins, then .env (same value PM2 uses), then the default.
if [ -z "${PORT:-}" ] && [ -f .env ]; then
  PORT="$(grep -m1 '^PORT=' .env | cut -d= -f2- || true)"
fi
export PORT="${PORT:-8787}"

# Where each session's sc stores its ~/.simple (cookie + .scratch localStorage):
# under Node's os.tmpdir() as sc-home-<random>/. Resolve it the same way the
# server does so the printed path matches (respects $TMPDIR).
SC_TMP="$(node -e 'process.stdout.write(require("os").tmpdir())')"
echo "==> Session storage: $SC_TMP/sc-home-*/.simple   (per session, removed on reap/shutdown)"

echo "==> sc-bridge on http://localhost:$PORT   (open it for the terminal page)"

# Public URL the glasses should point at. Prefer PUBLIC_HOST; otherwise look up
# the box's public IP (falling back to a LAN IP if there's no outbound network).
PUBLIC_HOST="${PUBLIC_HOST:-}"
if [ -z "$PUBLIC_HOST" ]; then
  PUBLIC_HOST="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$PUBLIC_HOST" ]; then
  # Linux: hostname -I lists interface IPs; take the first non-loopback one.
  PUBLIC_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi

if [ -n "$PUBLIC_HOST" ]; then
  echo "==> Public URL: http://$PUBLIC_HOST:$PORT"
else
  echo "==> Public URL: could not detect host IP (set PUBLIC_HOST=<ip> to print it)"
fi

exec node serve.mjs
