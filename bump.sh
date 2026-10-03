#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Usage: ./bump.sh [patch|minor|major|<x.y.z>]   (default: patch)
#
# Bumps package.json, package-lock.json and app.json in one go. npm version
# updates the first two, its "version" script in package.json copies the new
# version into app.json, then it commits all three as x.y.z tagged vx.y.z.

APP_VERSION="$(node -p "require('./app.json').version")"
PKG_VERSION="$(node -p "require('./package.json').version")"
if [ "$APP_VERSION" != "$PKG_VERSION" ]; then
  echo "app.json version ($APP_VERSION) and package.json version ($PKG_VERSION) differ. Make them match before bumping." >&2
  exit 1
fi

npm version "${1:-patch}"

echo
echo "Next: ./package.sh"
