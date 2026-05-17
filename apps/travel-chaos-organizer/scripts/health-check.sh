#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://localhost:8000}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILURES=$((FAILURES+1)); }
FAILURES=0

echo "=== TCO Health Check (${BASE}) ==="

# Backend health
resp=$(curl -sf "${BASE}/health" 2>/dev/null) && ok "Backend healthy: $resp" || fail "Backend /health failed"

# Postgres via backend
echo "$resp" | grep -q '"status":"ok"' && ok "DB connected" || fail "DB not connected"

# Cachly cache status
echo "$resp" | grep -q '"cachly_cache":"enabled"' && ok "Cachly cache enabled" \
  || echo -e "${YELLOW}!${NC} Cachly cache disabled (CACHLY_REDIS_URL not set)"

# Admin dashboard
curl -sf "${BASE}/admin" -o /dev/null && ok "Admin dashboard reachable" || fail "Admin dashboard unreachable"

# Waitlist endpoint
curl -sf -X POST "${BASE}/api/v1/waitlist" -H "Content-Type: application/json" \
  -d '{"email":"healthcheck@tco.internal","source":"healthcheck"}' -o /dev/null 2>/dev/null \
  && ok "Waitlist endpoint responding" || fail "Waitlist endpoint failed"

echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}All checks passed.${NC}"
else
  echo -e "${RED}${FAILURES} check(s) failed.${NC}"
  exit 1
fi
