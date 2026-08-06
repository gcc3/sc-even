#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Stops the sc-bridge backend started by ./start.sh (PM2 + ecosystem.config.cjs).
#
# Usage:
#   ./stop.sh                  # stop the sc-bridge process
#   ./stop.sh --delete         # stop AND remove it from the PM2 process list

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found on PATH — nothing to stop." >&2
  exit 0
fi

# The process name comes from PM2_NAME in .env; passing the ecosystem file lets
# PM2 resolve it, so this only needs the name for the message.
PM2_NAME="$(grep -m1 '^PM2_NAME=' .env 2>/dev/null | cut -d= -f2- || true)"
PM2_NAME="${PM2_NAME:-sc-bridge}"

if [ "${1:-}" = "--delete" ]; then
  pm2 delete ecosystem.config.cjs && echo "==> $PM2_NAME stopped and removed from PM2."
else
  pm2 stop ecosystem.config.cjs && echo "==> $PM2_NAME stopped (still in PM2 list; ./start.sh to resume)."
fi
