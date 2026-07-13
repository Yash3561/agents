#!/usr/bin/env bash
# smoke-tests.sh — Hit the live Azure deployment with real HTTP calls.
# Exits non-zero if any critical test fails.
#
# Usage:
#   ./scripts/smoke-tests.sh [BASE_URL]
#
# If BASE_URL is omitted, defaults to the production Azure URL.
#
# ponytail: the storefront-widget-specific tests (widget-config, /api/chat,
# /api/greeting) were removed — the widget is permanently disabled
# (extensions/chat-widget/blocks/chat.liquid gates it behind np_enabled =
# false), and every deploy run of the old tests was writing real
# Conversation rows into the live neonping-dev shop under fixed session IDs
# (smoke-anon-1/2/3), accumulating indefinitely across every staging +
# production deploy. If the widget ever comes back, restore those tests
# against a dedicated smoke-test shop, not the real dev store.

BASE_URL="${1:-https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io}"
TIMEOUT=30

# ── colour helpers ────────────────────────────────────────────────────────────
GREEN="\033[0;32m"
RED="\033[0;31m"
RESET="\033[0m"

PASS=0
FAIL=0

pass() { echo -e "${GREEN}PASS${RESET}  $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${RESET}  $1"; FAIL=$((FAIL + 1)); }

# ── helpers ───────────────────────────────────────────────────────────────────

# http_status URL [extra curl args...]
http_status() {
  local url="$1"; shift
  curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$@" "$url"
}

# http_body URL [extra curl args...]
http_body() {
  local url="$1"; shift
  curl -s --max-time "$TIMEOUT" "$@" "$url"
}

echo ""
echo "NeonPing smoke tests — ${BASE_URL}"
echo "──────────────────────────────────────────────────────────────────"

# ── Test 1: GET /health → 200 + status:ok ────────────────────────────────────
T="GET /health → 200 + {\"status\":\"ok\"}"
STATUS=$(http_status "${BASE_URL}/health")
BODY=$(http_body "${BASE_URL}/health")
if [ "$STATUS" = "200" ] && echo "$BODY" | grep -q '"status":"ok"'; then
  pass "$T"
else
  fail "$T (HTTP $STATUS, body: $BODY)"
fi

# ── Test 2: GET /api/whatsapp/webhook (verification handshake) → 403 ─────────
T="GET /api/whatsapp/webhook (no verify token) → 403 (endpoint reachable, correctly rejects)"
STATUS=$(http_status "${BASE_URL}/api/whatsapp/webhook")
if [ "$STATUS" = "403" ]; then
  pass "$T"
else
  fail "$T (HTTP $STATUS — expected 403)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo "──────────────────────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${PASS}/${TOTAL} tests passed${RESET}"
  exit 0
else
  echo -e "${RED}${PASS}/${TOTAL} tests passed — ${FAIL} FAILED${RESET}"
  exit 1
fi
