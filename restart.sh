#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Deploy + restart the sc-bridge backend managed by PM2 (ecosystem.config.cjs):
# pull the latest code, install dependencies, then restart the process.
#
# Usage:
#   ./restart.sh               # git pull + npm install + pm2 restart

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found on PATH. Install it with: npm install -g pm2" >&2
  exit 1
fi

echo "==> Pulling latest code"
git pull

echo "==> Installing dependencies"
npm install

echo "==> Loading .env"
if [ -f .env ]; then
  set -a && source .env && set +a
fi

echo "==> Restarting sc-bridge"
pm2 restart ecosystem.config.cjs --update-env && echo "==> sc-bridge restarted."
