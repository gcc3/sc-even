#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Start the dev server in the background
npm run dev -- --host 0.0.0.0 --port 5173 --strictPort &
DEV_PID=$!

# Stop the dev server when this script exits
trap 'kill "$DEV_PID" 2>/dev/null' EXIT

# Start the eventhub simulator pointing at the dev server
evenhub-simulator http://localhost:5173/
