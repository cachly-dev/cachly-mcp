#!/usr/bin/env bash
# Verify that all telemetry/tracking systems are configured and reachable.
set -euo pipefail

BASE="${1:-http://localhost:8000}"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1 (optional but recommended)"; }
fail() { echo -e "${RED}✗${NC} $1"; }

echo "=== TCO Tracking Verification ==="
echo ""

# Load .env if present
[[ -f .env ]] && export $(grep -v '^#' .env | grep -v '^$' | xargs) 2>/dev/null || true

# 1. Backend telemetry (events table)
resp=$(curl -sf "${BASE}/health" 2>/dev/null || echo "{}")
echo "$resp" | grep -q '"status":"ok"' && ok "Backend events table: reachable" || fail "Backend unreachable — events not tracked"

# 2. Cachly Redis cache
echo "$resp" | grep -q '"cachly_cache":"enabled"' \
  && ok "Cachly Redis cache: enabled (parse deduplication active)" \
  || warn "Cachly Redis cache: disabled — set CACHLY_REDIS_URL for deduplication"

# 3. Sentry
[[ -n "${SENTRY_DSN:-}" ]] \
  && ok "Sentry DSN: configured (${SENTRY_DSN:0:30}...)" \
  || warn "Sentry DSN: not set — errors won't be tracked remotely"

# 4. Telegram
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TCO_TELEGRAM_CHAT_ID:-}" ]]; then
  tg_resp=$(curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || echo "{}")
  echo "$tg_resp" | grep -q '"ok":true' \
    && ok "Telegram: bot token valid ($(echo "$tg_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['username'])" 2>/dev/null || echo '?'))" \
    || fail "Telegram: bot token invalid or unreachable"
else
  warn "Telegram: not configured — set TELEGRAM_BOT_TOKEN + TCO_TELEGRAM_CHAT_ID"
fi

# 5. Resend email
[[ -n "${RESEND_API_KEY:-}" ]] \
  && ok "Resend: API key configured" \
  || warn "Resend: not configured — no transactional emails"

# 6. Stripe
[[ -n "${STRIPE_SECRET_KEY:-}" ]] \
  && ok "Stripe: secret key configured" \
  || warn "Stripe: not configured — no payment processing"

# 7. Ollama
OLLAMA_HOST="${OLLAMA_URL:-http://localhost:11434}"
curl -sf "${OLLAMA_HOST}/api/tags" -o /dev/null 2>/dev/null \
  && ok "Ollama: reachable at ${OLLAMA_HOST}" \
  || warn "Ollama: not reachable at ${OLLAMA_HOST} — AI parsing won't work"

# 8. Admin event summary (requires auth)
if [[ -n "${ADMIN_USER:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  ev_resp=$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASSWORD}" "${BASE}/admin/events/summary" 2>/dev/null || echo "{}")
  total=$(echo "$ev_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('events',[])))" 2>/dev/null || echo "?")
  ok "Admin events API: $total event types tracked"
fi

echo ""
echo "=== Tracking summary ==="
echo "  Events DB:    always on"
echo "  Cachly cache: ${CACHLY_REDIS_URL:+enabled}${CACHLY_REDIS_URL:-disabled}"
echo "  Sentry:       ${SENTRY_DSN:+configured}${SENTRY_DSN:-not set}"
echo "  Telegram:     ${TELEGRAM_BOT_TOKEN:+configured}${TELEGRAM_BOT_TOKEN:-not set}"
echo "  Resend:       ${RESEND_API_KEY:+configured}${RESEND_API_KEY:-not set}"
echo "  Stripe:       ${STRIPE_SECRET_KEY:+configured}${STRIPE_SECRET_KEY:-not set}"
