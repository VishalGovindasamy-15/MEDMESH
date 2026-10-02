#!/usr/bin/env bash
# Bring a clean container up to a running MedMesh pilot.
#
#   ./tools/dev-up.sh            # backend + keyless web build on :8080
#   ./tools/dev-up.sh --keyed    # also serve the keyed build on :8081
#
# Everything this installation needs lives outside the repository -- the Python
# environment, node_modules and the web export are all deliberately not checked
# in -- so a fresh clone has none of them. This installs what is missing, builds
# the web bundle, and prints the two commands that actually start the API and the
# preview server. It does not start them itself: a script that leaves background
# processes behind is a script people run twice.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYED=0
[[ "${1:-}" == "--keyed" ]] && KEYED=1

echo "== python environment"
python3 -m pip install -q -r "$ROOT/backend/requirements.txt"

echo "== demo configuration"
if [[ ! -f "$ROOT/backend/.env" ]]; then
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  echo "   wrote backend/.env from .env.example"
fi

echo "== mobile dependencies"
cd "$ROOT/mobile"
[[ -d node_modules ]] || npm install --no-audit --no-fund

echo "== database"
if [[ ! -f "$ROOT/backend/medmesh.db" ]]; then
  cd "$ROOT/backend"
  python3 - <<'PY'
from app.database import Base, engine, SessionLocal
from app.seed import seed_all
Base.metadata.create_all(bind=engine)
seed_all(SessionLocal())
print("   seeded a fresh pilot dataset")
PY
fi

echo "== web bundle (keyless)"
cd "$ROOT/mobile"
npx expo export --platform web --clear >/dev/null
echo "   → mobile/dist"

if [[ $KEYED -eq 1 ]]; then
  echo "== web bundle (Google Maps keyed)"
  # A placeholder key is enough to make the build take the keyed code path; the
  # key itself is supplied at runtime through the environment.
  EXPO_PUBLIC_GOOGLE_MAPS_API_KEY="${EXPO_PUBLIC_GOOGLE_MAPS_API_KEY:-AIzaSyDUMMYKEYFORTESTS_0123456789}" \
    npx expo export --platform web --clear --output-dir dist-gmaps >/dev/null
  echo "   → mobile/dist-gmaps"
fi

cat <<EOF

Ready. Start the two processes in separate terminals:

  cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-level warning
  node tools/preview-server.mjs

Then open http://localhost:8080. Demo sign-ins are on the sign-in screen when
MEDMESH_DEMO_MODE=true; see README.md.
EOF
