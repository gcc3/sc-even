#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Packages this app into a .ehpk file for publishing to the Even Realities Hub.
# Flow (per https://hub.evenrealities.com/docs/):
#   1. Build the web app  -> dist/
#   2. evenhub pack        -> <package_id>-<version>.ehpk
#   3. Upload the .ehpk to the Even Hub dev portal to submit.

APP_JSON="app.json"
DIST_DIR="dist"

echo "==> Checking evenhub CLI"
if ! command -v evenhub >/dev/null 2>&1; then
  echo "    evenhub not found on PATH."
  echo "    Install it: npm i -g @evenrealities/evenhub-cli"
  echo "    Docs: https://hub.evenrealities.com/docs/getting-started/overview"
  exit 1
fi

# Derive the output name from app.json (package_id + version).
PACKAGE_ID=$(node -p "require('./$APP_JSON').package_id" 2>/dev/null || echo "app")
VERSION=$(node -p "require('./$APP_JSON').version" 2>/dev/null || echo "0.0.0")
OUTPUT="${PACKAGE_ID}-${VERSION}.ehpk"

echo "==> Checking OPENAI_API_KEY"
if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -q "^OPENAI_API_KEY=" .env 2>/dev/null; then
  echo "    OPENAI_API_KEY is not set."
  echo "    Create a .env file with: OPENAI_API_KEY=sk-..."
  exit 1
fi

echo "==> Building web app (npm run build)"
npm run build

if [ ! -d "$DIST_DIR" ]; then
  echo "    Build did not produce '$DIST_DIR/'. Aborting."
  exit 1
fi

echo "==> Packing into $OUTPUT"
evenhub pack "$APP_JSON" "$DIST_DIR" -o "$OUTPUT"

echo
echo "Done: $OUTPUT"
echo "Next: upload it to the Even Hub dev portal to publish."
echo "  (Run 'evenhub login' first if you haven't.)"
echo
echo "Upload to \`https://hub.evenrealities.com/hub/${PACKAGE_ID}\`"
