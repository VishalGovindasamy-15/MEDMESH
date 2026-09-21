#!/usr/bin/env bash
# One-time (per container) QA setup.
#
# Neither node_modules nor the browser cache survive a workspace snapshot, and a
# fresh container also lacks the shared libraries Chromium links against. This is
# idempotent, so it is safe to run before any harness invocation.
set -euo pipefail
cd "$(dirname "$0")"

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/user/.cache/ms-playwright}"

npm install --silent playwright@1.63.0
if [ ! -x "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" ]; then
  npx playwright install chromium
fi

# Chromium needs libnss3/libatk/libasound2 etc. install-deps needs root.
if ! ldconfig -p 2>/dev/null | grep -q libatk-1.0; then
  npx playwright install-deps chromium
fi

echo "qa environment ready (PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH)"
