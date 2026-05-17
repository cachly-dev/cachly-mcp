#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://localhost:8000}"
GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo "=== TCO Smoke Test (${BASE}) ==="

# Health
curl -sf "${BASE}/health" | grep -q '"status":"ok"' && ok "Health OK" || fail "Health check failed"

# Waitlist
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/v1/waitlist" \
  -H "Content-Type: application/json" -d '{"email":"smoke@tco.test","source":"smoke"}')
[[ "$CODE" =~ ^2 ]] && ok "Waitlist POST → HTTP $CODE" || fail "Waitlist POST failed: HTTP $CODE"
# Note: smoke@tco.test entry stays in waitlist — harmless, remove via admin dashboard

# Admin (unauthenticated → 401 for JSON endpoints, 200 for HTML page)
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/admin")
[[ "$CODE" == "200" ]] && ok "Admin dashboard → HTTP $CODE" || fail "Admin dashboard failed: HTTP $CODE"

# Docs hidden in production
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/docs")
[[ "$CODE" == "404" ]] && ok "Swagger docs hidden (production mode)" \
  || echo -e "\033[1;33m!\033[0m Swagger docs exposed at /docs (DEBUG=true?)"

echo ""
echo -e "${GREEN}Smoke test complete.${NC}"
