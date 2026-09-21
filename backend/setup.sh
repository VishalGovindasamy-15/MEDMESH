#!/usr/bin/env bash
# One-time (per container) backend setup.
#
# site-packages does not survive a workspace snapshot, so a restored workspace
# needs its dependencies reinstalled before the API will start. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"

pip install -q -r requirements.txt
echo "backend dependencies installed"
