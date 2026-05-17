#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
echo "[migrate] Running Alembic migrations..."
docker compose exec backend alembic upgrade head
echo "[migrate] Done."
