#!/usr/bin/env bash
# One-time (per container) frontend setup, and the supported way to produce a
# web build for the preview server.
#
# Two things this script exists to get right:
#
#  1. `node_modules` and `dist/` are both excluded from workspace snapshots, so
#     a restored workspace needs them rebuilt before the app is served.
#  2. `--clear` is not optional. `EXPO_PUBLIC_*` variables are inlined into the
#     bundle at transform time, and Metro's cache key does not always include
#     the environment — so exporting with a Maps key and then exporting without
#     one can ship the *previous* key. That happened here: a build meant to have
#     no key carried the test key, and the app tried to load Google Maps with it.
#     Always clearing the bundler cache makes the build a pure function of the
#     current environment, which is the property that actually matters.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/react-native ]; then
  npm install --silent
fi

npx expo export --platform web --clear
echo "frontend ready — dist/ rebuilt from the current environment"
