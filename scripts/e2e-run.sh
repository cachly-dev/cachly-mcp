#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cachly E2E test runner
#
# Usage:
#   ./scripts/e2e-run.sh                 # run all e2e tests
#   ./scripts/e2e-run.sh api             # only API health + auth tests
#   ./scripts/e2e-run.sh tools           # only MCP tool tests (needs Redis creds)
#   ./scripts/e2e-run.sh cli             # only CLI smoke tests
#   ./scripts/e2e-run.sh funnel          # only funnel telemetry tests
#   ./scripts/e2e-run.sh provisioning    # provisioning lifecycle (slow, ~5 min)
#
# Required env vars:
#   E2E_API_URL       https://api.dev.cachly.dev   (or prod)
#   E2E_JWT           <keycloak access token>
#   E2E_INSTANCE_ID   <uuid of active test Brain>
#   E2E_API_KEY       <redis password>
#   E2E_REDIS_HOST    <redis host>
#
# Optional:
#   E2E_REDIS_PORT    6380
#   E2E_REDIS_TLS     true
#   E2E_SKIP_SLOW     true   (skip provisioning + device flow)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Load .env.test if present (convenience for local dev) ─────────────────────
if [[ -f "$ROOT/.env.test" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env.test"
  set +a
  echo -e "\033[90m[e2e] Loaded $ROOT/.env.test\033[0m"
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
export E2E_API_URL="${E2E_API_URL:-https://api.cachly.dev}"
export E2E_REDIS_PORT="${E2E_REDIS_PORT:-6380}"
export E2E_REDIS_TLS="${E2E_REDIS_TLS:-true}"
export E2E_SKIP_SLOW="${E2E_SKIP_SLOW:-false}"

# ── Color output ──────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

header() { echo -e "\n${YELLOW}━━━ $1 ━━━${NC}"; }
ok()     { echo -e "${GREEN}✓ $1${NC}"; }
fail()   { echo -e "${RED}✗ $1${NC}"; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
header "Pre-flight"

if [[ -z "${E2E_JWT:-}" ]]; then
  fail "E2E_JWT is not set. Export a valid Keycloak token."
  echo "  Hint: copy your JWT from https://${E2E_API_URL}/api/v1/debug/me after login"
  exit 1
fi
ok "E2E_JWT is set (length: ${#E2E_JWT})"

if [[ -z "${E2E_INSTANCE_ID:-}" ]]; then
  echo -e "${YELLOW}⚠  E2E_INSTANCE_ID not set — instance-specific tests will be skipped${NC}"
else
  ok "E2E_INSTANCE_ID: $E2E_INSTANCE_ID"
fi

# ── Build ─────────────────────────────────────────────────────────────────────
header "Building"
npm run build
ok "Build complete"

# ── Select test suite ─────────────────────────────────────────────────────────
SUITE="${1:-all}"

VITEST_BASE="npx vitest run --reporter=verbose"
E2E_DIR="src/__tests__/e2e"

run_suite() {
  local name="$1"; local pattern="$2"
  header "Running: $name"
  $VITEST_BASE "$pattern" && ok "$name passed" || { fail "$name FAILED"; exit 1; }
}

case "$SUITE" in
  api)
    run_suite "API health + auth" "$E2E_DIR/api-health.test.ts $E2E_DIR/api-auth.test.ts"
    ;;
  tools)
    if [[ -z "${E2E_API_KEY:-}" || -z "${E2E_REDIS_HOST:-}" ]]; then
      fail "E2E_API_KEY and E2E_REDIS_HOST required for MCP tool tests"
      exit 1
    fi
    run_suite "MCP tools" "$E2E_DIR/mcp-tools.test.ts"
    ;;
  cli)
    run_suite "CLI smoke" "$E2E_DIR/cli.test.ts"
    ;;
  funnel)
    run_suite "Funnel telemetry" "$E2E_DIR/funnel.test.ts"
    ;;
  provisioning)
    export E2E_SKIP_SLOW=false
    run_suite "Provisioning lifecycle" "$E2E_DIR/provisioning.test.ts"
    ;;
  all)
    header "Running ALL e2e suites"

    echo ""
    echo "  API URL:      $E2E_API_URL"
    echo "  Instance ID:  ${E2E_INSTANCE_ID:-(not set)}"
    echo "  Redis host:   ${E2E_REDIS_HOST:-(not set — tool tests will fail)}"
    echo "  Skip slow:    $E2E_SKIP_SLOW"
    echo ""

    FAILED=()

    run_one() {
      local name="$1"; local file="$2"
      header "$name"
      if $VITEST_BASE "$file"; then
        ok "$name passed"
      else
        fail "$name FAILED"
        FAILED+=("$name")
      fi
    }

    run_one "API health (no auth)"  "$E2E_DIR/api-health.test.ts"
    run_one "API auth + instances"  "$E2E_DIR/api-auth.test.ts"
    run_one "Funnel telemetry"      "$E2E_DIR/funnel.test.ts"
    run_one "CLI smoke tests"       "$E2E_DIR/cli.test.ts"

    if [[ -n "${E2E_API_KEY:-}" && -n "${E2E_REDIS_HOST:-}" ]]; then
      run_one "MCP tools (live Redis)" "$E2E_DIR/mcp-tools.test.ts"
    else
      echo -e "${YELLOW}⚠  Skipping MCP tool tests (E2E_API_KEY / E2E_REDIS_HOST not set)${NC}"
    fi

    if [[ "$E2E_SKIP_SLOW" != "true" ]]; then
      run_one "Provisioning lifecycle" "$E2E_DIR/provisioning.test.ts"
    else
      echo -e "${YELLOW}⚠  Skipping provisioning tests (E2E_SKIP_SLOW=true)${NC}"
    fi

    echo ""
    if [[ ${#FAILED[@]} -eq 0 ]]; then
      echo -e "${GREEN}━━━ ALL E2E TESTS PASSED ━━━${NC}"
    else
      echo -e "${RED}━━━ FAILED SUITES: ${FAILED[*]} ━━━${NC}"
      exit 1
    fi
    ;;
  *)
    echo "Unknown suite: $SUITE"
    echo "Usage: $0 [all|api|tools|cli|funnel|provisioning]"
    exit 1
    ;;
esac
