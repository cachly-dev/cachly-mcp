#!/usr/bin/env bash
# Interactive wizard to configure .env for production.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ask()  { echo -e "${CYAN}?${NC} $1"; }
info() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

ENV_FILE=".env"
[[ -f "$ENV_FILE" ]] || cp .env.example "$ENV_FILE"

set_var() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Travel Chaos Organizer — .env Setup ║"
echo "╚══════════════════════════════════════╝"
echo ""

ask "Domain (e.g. tco.example.com, or press Enter to skip):"; read -r DOMAIN
[[ -n "$DOMAIN" ]] && set_var "TCO_DOMAIN" "$DOMAIN" && info "Domain set."

ask "Admin username [admin]:"; read -r ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"
set_var "ADMIN_USER" "$ADMIN_USER"

ask "Admin password (min 16 chars):"; read -rsp "" ADMIN_PASS; echo
while [[ ${#ADMIN_PASS} -lt 16 ]]; do
  warn "Too short. Min 16 characters."; read -rsp "" ADMIN_PASS; echo
done
set_var "ADMIN_PASSWORD" "$ADMIN_PASS"
info "Admin credentials set."

ask "Resend API key (Enter to skip):"; read -r RESEND_KEY
[[ -n "$RESEND_KEY" ]] && set_var "RESEND_API_KEY" "$RESEND_KEY" && info "Resend configured."

ask "Resend FROM address [noreply@tco.app]:"; read -r RESEND_FROM
RESEND_FROM="${RESEND_FROM:-noreply@tco.app}"
set_var "RESEND_FROM" "$RESEND_FROM"

ask "Sentry DSN (Enter to skip):"; read -r SENTRY_DSN
[[ -n "$SENTRY_DSN" ]] && set_var "SENTRY_DSN" "$SENTRY_DSN" && info "Sentry configured."

ask "Telegram Bot Token (Enter to skip):"; read -r TG_TOKEN
if [[ -n "$TG_TOKEN" ]]; then
  set_var "TELEGRAM_BOT_TOKEN" "$TG_TOKEN"
  ask "Telegram Chat ID for TCO events:"; read -r TG_CHAT
  set_var "TCO_TELEGRAM_CHAT_ID" "$TG_CHAT"
  info "Telegram configured."
fi

ask "Stripe Secret Key (Enter to skip):"; read -r STRIPE_SK
if [[ -n "$STRIPE_SK" ]]; then
  set_var "STRIPE_SECRET_KEY" "$STRIPE_SK"
  ask "Stripe Webhook Secret (whsec_...):"; read -r STRIPE_WH
  set_var "STRIPE_WEBHOOK_SECRET" "$STRIPE_WH"
  ask "Stripe Pro Price ID (price_...):"; read -r STRIPE_PRICE
  set_var "STRIPE_PRO_PRICE_ID" "$STRIPE_PRICE"
  info "Stripe configured."
fi

ask "Ollama URL [http://localhost:11434]:"; read -r OLLAMA_URL
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
set_var "OLLAMA_URL" "$OLLAMA_URL"

set_var "ENVIRONMENT" "production"
set_var "DEBUG" "false"

echo ""
info "=== .env written to $ENV_FILE ==="
warn "Review it: cat $ENV_FILE"
