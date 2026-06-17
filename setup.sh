#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing npm dependencies"
npm install

# Vite 8 bundles with Rolldown. Its packages (@rolldown/pluginutils and the
# platform-native binding) can be left out by an incomplete/interrupted install
# or a known npm optional-deps bug, leaving Vite unable to start
# (ERR_MODULE_NOT_FOUND for @rolldown/*). Recover with a clean install from the
# lockfile. `npm ci` wipes node_modules and installs exactly what the lockfile
# pins — and never rewrites package-lock.json, so the committed file stays clean.
if [ ! -f node_modules/@rolldown/pluginutils/dist/index.mjs ]; then
  echo "==> Rolldown install looks incomplete — reinstalling with npm ci"
  npm ci
fi

echo "==> Copying .env.example -> .env (if .env does not exist)"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    Created .env from .env.example — fill in your OPENAI_API_KEY."
else
  echo "    .env already exists, skipping."
fi

echo "==> Making helper scripts executable"
chmod +x start.sh stop.sh restart.sh develop.sh setup.sh serve.sh 2>/dev/null || true

echo "==> Checking evenhub CLI (used by develop.sh for the QR code)"
if command -v evenhub >/dev/null 2>&1; then
  echo "    evenhub found: $(command -v evenhub)"
else
  echo "    evenhub not found on PATH."
  echo "    Install it per the Even Realities docs: https://hub.evenrealities.com/docs/getting-started/overview"
fi

echo
echo "Setup complete. Next:"
echo "  1. Put your OpenAI key in .env (OPENAI_API_KEY)"
echo "  2. ./develop.sh   # dev server on 0.0.0.0:5173 (+ QR for the glasses)"
echo "     (or ./start.sh to run the sc-bridge backend under PM2)"
