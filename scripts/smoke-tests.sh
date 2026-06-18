#!/usr/bin/env bash
# smoke-tests.sh — Hit the live Azure deployment with real HTTP calls.
# Exits non-zero if any critical test fails.
#
# Usage:
#   ./scripts/smoke-tests.sh [BASE_URL]
#
# If BASE_URL is omitted, defaults to the production Azure URL.

BASE_URL="${1:-https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io}"
SHOP="neonping-dev.myshopify.com"
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

# sse_output URL body_json — returns the SSE text captured within TIMEOUT seconds
sse_output() {
  local url="$1"
  local body="$2"
  curl -s --no-buffer --max-time "$TIMEOUT" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || true
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

# ── Test 2: GET /api/widget-config → 200 ─────────────────────────────────────
T="GET /api/widget-config?shop=${SHOP} → 200"
STATUS=$(http_status "${BASE_URL}/api/widget-config?shop=${SHOP}")
if [ "$STATUS" = "200" ]; then
  pass "$T"
else
  fail "$T (HTTP $STATUS)"
fi

# ── Test 3: POST /api/chat hello → 200 + SSE data: ───────────────────────────
T="POST /api/chat hello → 200 SSE stream with data:"
OUTPUT=$(sse_output "${BASE_URL}/api/chat" \
  '{"session_id":"smoke-anon-1","shop":"'"${SHOP}"'","message":"Hello"}')
if echo "$OUTPUT" | grep -q "data:"; then
  pass "$T"
else
  fail "$T (no 'data:' in output)"
fi

# ── Test 4: POST /api/chat product search → non-empty response ───────────────
T="POST /api/chat 'show me resistance bands' → non-empty SSE response"
OUTPUT=$(sse_output "${BASE_URL}/api/chat" \
  '{"session_id":"smoke-anon-2","shop":"'"${SHOP}"'","message":"show me resistance bands"}')
if [ -n "$OUTPUT" ] && echo "$OUTPUT" | grep -q "data:"; then
  pass "$T"
else
  fail "$T (empty or no data: lines)"
fi

# ── Test 5: POST /api/chat emoji query → non-empty (emoji strip working) ──────
T="POST /api/chat emoji query '💪 show me bands 🏋️' → non-empty SSE response"
OUTPUT=$(sse_output "${BASE_URL}/api/chat" \
  '{"session_id":"smoke-anon-3","shop":"'"${SHOP}"'","message":"💪 show me bands 🏋️"}')
if [ -n "$OUTPUT" ] && echo "$OUTPUT" | grep -q "data:"; then
  pass "$T"
else
  fail "$T (empty or no data: lines — emoji strip may be broken)"
fi

# ── Test 6: GET /api/greeting anonymous → 200 + greeting key ─────────────────
T="GET /api/greeting (no customer_id) → 200 + {\"greeting\":...}"
STATUS=$(http_status "${BASE_URL}/api/greeting?shop=${SHOP}")
BODY=$(http_body "${BASE_URL}/api/greeting?shop=${SHOP}")
if [ "$STATUS" = "200" ] && echo "$BODY" | grep -q '"greeting"'; then
  pass "$T"
else
  fail "$T (HTTP $STATUS, body: $BODY)"
fi

# ── Test 7: GET /api/greeting invalid customer → 200 (graceful failure) ───────
T="GET /api/greeting invalid customer_id → 200 graceful failure"
STATUS=$(http_status "${BASE_URL}/api/greeting?shop=${SHOP}&customer_id=invalid")
BODY=$(http_body "${BASE_URL}/api/greeting?shop=${SHOP}&customer_id=invalid")
if [ "$STATUS" = "200" ]; then
  pass "$T"
else
  fail "$T (HTTP $STATUS, body: $BODY)"
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
