#!/usr/bin/env bash
# Build a shareable archive of MedMesh without any of the things that must not
# be shared.
#
#   ./tools/package-release.sh [out/medmesh-release.zip]
#
# The rule this enforces, from the release review: a zip handed to another team
# must not carry the running environment with it. No credentials (.env), no
# database (*.db and its WAL sidecars), no generated app state (.expo,
# .android), no dependencies (node_modules) and no build output (dist,
# dist-gmaps). Everything the recipient needs to reproduce those is in the
# repository: .env.example documents the configuration, backend/setup.sh and
# tools/dev-up.sh rebuild the rest.
#
# The exclusion list below is the audit's, kept in one place so "we forgot the
# WAL file" is not a sentence anybody has to say again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/out/medmesh-release.zip}"
mkdir -p "$(dirname "$OUT")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "== staging a clean tree"
# git archive honours .gitignore-independent export-ignore rules; but the
# simplest honest filter is an explicit rsync, because the point of this script
# is that the exclusion list is visible and reviewable.
rsync -a \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.*.local' \
  --exclude '*.db' \
  --exclude '*.db-journal' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude 'node_modules' \
  --exclude '.expo' \
  --exclude '.android' \
  --exclude '.ios' \
  --exclude '.gradle' \
  --exclude '.cache' \
  --exclude 'dist' \
  --exclude 'dist-gmaps' \
  --exclude 'web-build' \
  --exclude 'out' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.pytest_cache' \
  --exclude '.DS_Store' \
  --exclude '*.keystore' --exclude '*.jks' \
  --exclude 'credentials.json' --exclude 'google-services.json' \
  "$ROOT/" "$STAGE/medmesh/"

echo "== checking the staged tree for anything that must not ship"
BAD=0
while IFS= read -r hit; do
  echo "   REFUSE: $hit"
  BAD=1
done < <(
  find "$STAGE" \( \
    -name '.env' -o -name '.env.local' -o -name '*.db' -o -name '*.db-wal' \
    -o -name '*.db-shm' -o -name '*.db-journal' -o -name 'node_modules' \
    -o -name '.expo' -o -name '.android' -o -name 'dist' -o -name 'dist-gmaps' \
    -o -name '*.keystore' -o -name 'credentials.json' \
  \) -print
)
if [[ $BAD -ne 0 ]]; then
  echo "archive would carry forbidden files — aborting" >&2
  exit 1
fi

# .env.example is the one environment file that ships; assert it is present so
# a refactor that renames it fails here rather than in the recipient's inbox.
if [[ ! -f "$STAGE/medmesh/backend/.env.example" ]]; then
  echo "backend/.env.example is missing — the archive must ship it" >&2
  exit 1
fi

echo "== zipping"
( cd "$STAGE" && zip -qr "$OUT" medmesh )
echo "   wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "Contents are source only. The recipient rebuilds with:"
echo "  ./tools/dev-up.sh          # python env, seed data, web bundle"
echo "  ./tools/qa/bootstrap.sh    # browser harnesses"
