#!/usr/bin/env bash
# QA harness bootstrap.
#
# The harnesses in this directory are run from a disposable container: the
# browser build, the system libraries it links against and node_modules all live
# outside the repository and none of them survive a rebuild. This puts them back
# in one step, in the order that works -- the shared libraries have to be in
# place before Playwright will launch, or it reports a missing .so rather than a
# missing package and the error reads like a bug in the harness.
#
#   ./tools/qa/bootstrap.sh
#
# Re-run after any container rebuild. It is idempotent and cheap when everything
# is already present.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

echo "== node modules"
cd "$HERE"
npm install --no-audit --no-fund

echo "== system libraries for chromium"
# Debian trixie renamed the t64 packages; try both spellings rather than
# assuming which base image this is running on.
PKGS=(
  libnspr4 libnss3
  libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64
  libxkbcommon0 libasound2t64 libxdamage1 libxcomposite1 libxrandr2
  libgbm1 libpango-1.0-0 libcairo2
)
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${PKGS[@]}" >/dev/null
fi

echo "== chromium"
npx playwright install chromium

echo
echo "ready. run the harnesses with:"
echo "  BASE=http://127.0.0.1:8080 node surfaces.mjs"
echo "  BASE=http://127.0.0.1:8080 node sweep.mjs"
echo "  BASE=http://127.0.0.1:8081 node maps.mjs"
