#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Serves the sc-bridge backend (serve.mjs): runs the `sc` (simple-ai-chat) CLI
# behind HTTP/SSE so the glasses app can reach it. One sc process per session —
# see serve.mjs for the env vars it accepts.
#
# Usage:
#   ./serve.sh                 # local only:  http://localhost:8787
#   PORT=9000 ./serve.sh       # custom port
#   TUNNEL=1 ./serve.sh        # also expose a public HTTPS URL (for the glasses)
#   TUNNEL=cloudflared ./serve.sh   # force cloudflared
#   TUNNEL=localtunnel ./serve.sh   # force localtunnel (npx; SEE NOTE below)
#
# The glasses can't reach `localhost`, and the published app needs HTTPS, so to
# test on-device you need a public HTTPS URL. TUNNEL=1 starts one and prints it.
# cloudflared is strongly preferred: localtunnel injects an interstitial page
# that breaks SSE (the /api/sc/stream the app depends on).
#   Install cloudflared: brew install cloudflared

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. Install Node.js first." >&2
  exit 1
fi

# The sc CLI ships as a dependency; install if it's missing.
if [ ! -x "node_modules/.bin/sc" ]; then
  echo "==> sc CLI not found — installing dependencies"
  npm install
fi

PORT="${PORT:-8787}"
TUNNEL="${TUNNEL:-}"

# Where each session's sc stores its ~/.simple (cookie + .scratch localStorage):
# under Node's os.tmpdir() as sc-home-<random>/. Resolve it the same way the
# server does so the printed path matches (respects $TMPDIR).
SC_TMP="$(node -e 'process.stdout.write(require("os").tmpdir())')"
echo "==> Session storage: $SC_TMP/sc-home-*/.simple   (per session, removed on reap/shutdown)"

# Local-only: no tunnel, just run the server in the foreground.
if [ -z "$TUNNEL" ]; then
  echo "==> sc-bridge on http://localhost:$PORT  (set TUNNEL=1 for a public URL)"
  exec node serve.mjs
fi

# Public mode: run the server in the background and start a tunnel alongside it.
echo "==> Starting sc-bridge on port $PORT"
node serve.mjs &
SERVER_PID=$!

TUNNEL_LOG="$(mktemp)"
TUNNEL_PID=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

URL_RE=""
if { [ "$TUNNEL" = "1" ] || [ "$TUNNEL" = "cloudflared" ]; } && command -v cloudflared >/dev/null 2>&1; then
  echo "==> Starting cloudflared tunnel"
  cloudflared tunnel --url "http://localhost:$PORT" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  URL_RE='https://[a-z0-9-]+\.trycloudflare\.com'
elif [ "$TUNNEL" = "1" ] || [ "$TUNNEL" = "localtunnel" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "==> cloudflared not found; falling back to localtunnel (npx)"
    echo "    NOTE: localtunnel's interstitial page can break SSE — for reliable"
    echo "          on-device use, install cloudflared: brew install cloudflared"
  fi
  npx -y localtunnel --port "$PORT" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  URL_RE='https://[a-z0-9-]+\.loca\.lt'
else
  echo "Tunnel provider '$TUNNEL' not available." >&2
  exit 1
fi

# Poll the tunnel output until it prints the public URL.
echo "==> Waiting for public URL…"
PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE "$URL_RE" "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  # Bail early if the tunnel process died.
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  sleep 1
done

echo
if [ -z "$PUBLIC_URL" ]; then
  echo "!! Could not detect a public URL. Tunnel output:" >&2
  cat "$TUNNEL_LOG" >&2
else
  echo "============================================================"
  echo "  Public URL:  $PUBLIC_URL"
  echo "------------------------------------------------------------"
  echo "  1. Add it to app.json -> permissions.network.whitelist,"
  echo "     then rebuild/republish the .ehpk."
  echo "  2. In the app: Settings -> SC server URL -> $PUBLIC_URL"
  echo "  (temporary URL — it changes every time you restart)"
  echo "============================================================"
fi
echo

# Keep running until the server exits (Ctrl-C cleans up both).
wait "$SERVER_PID"
