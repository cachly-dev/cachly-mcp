#!/usr/bin/env bash
# Deploy or update TCO. Safe to run multiple times.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
die()  { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

[[ -f .env ]] || die ".env not found. Copy .env.example to .env and fill in values."

info "=== TCO Deploy ==="
info "Dir: $APP_DIR"

# Pull latest images
info "Pulling Docker images..."
docker compose pull --quiet

# Build backend
info "Building backend..."
docker compose build --quiet backend

# Start services (except backup profile)
info "Starting services..."
docker compose up -d --remove-orphans

# Wait for backend health
info "Waiting for backend to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    info "Backend is healthy."
    break
  fi
  if [[ $i -eq 30 ]]; then
    die "Backend did not become healthy after 30 attempts."
  fi
  sleep 2
done

# Run Alembic migrations
info "Running database migrations..."
docker compose exec -T backend alembic upgrade head && info "Migrations applied." || warn "Alembic not available yet — run manually: docker compose exec backend alembic upgrade head"

# Show status
info ""
info "=== Deploy complete ==="
docker compose ps
info ""
info "Backend:  http://localhost:8000/health"
info "Admin UI: http://localhost:8000/admin"
