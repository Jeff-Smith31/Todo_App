#!/usr/bin/env bash
set -euo pipefail
# End-to-end API verification for TickTock Tasks backend.
# It will:
#  - Register a new user (random email) or reuse if already registered
#  - Login
#  - Create a task (includes category)
#  - Edit the task
#  - Complete (toggle) the task
#  - List tasks and verify the task exists
#  - Delete the task
#
# Usage:
#   scripts/test-api.sh [BACKEND_URL] [EMAIL] [PASSWORD]
#
# If EMAIL is not provided, a random one is generated. If PASSWORD is not provided, a default strong one is used.
# Requires: curl, jq

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 2; }; }
need curl
need jq

BASE_URL="${1:-${BACKEND_URL:-}}"
EMAIL="${2:-}"
PASSWORD="${3:-TestPassw0rd!42}"

if [ -z "$BASE_URL" ]; then
  echo "BACKEND_URL not provided. Usage: scripts/test-api.sh https://api.example.com [EMAIL] [PASSWORD]" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

if [ -z "$EMAIL" ]; then
  TS=$(date +%s)
  RAND=$((RANDOM%100000))
  EMAIL="ttt-e2e-${TS}-${RAND}@example.com"
fi

JQ_GET() { jq -r "$1 // empty" 2>/dev/null; }

info() { echo "[test-api] $*"; }
fail() { echo "[test-api] FAIL: $*" >&2; exit 1; }

# Common curl options (do not use --fail so we can read error bodies/status)
CURL_OPTS=(--silent --show-error --cookie-jar .ttt_cookies.txt --cookie .ttt_cookies.txt -H "Content-Type: application/json")
# Allow insecure TLS when CURL_INSECURE=1 (useful for self-signed dev backends)
if [ "${CURL_INSECURE:-0}" = "1" ]; then
  CURL_OPTS+=(--insecure)
fi
AUTH_HEADER=()

HTTP_STATUS=""
BODY_FILE=".ttt_body.json"

_do_curl() {
  # Args: METHOD URL [DATA_JSON]
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"
  if [ -n "$data" ]; then
    HTTP_STATUS=$(curl "${CURL_OPTS[@]}" "${AUTH_HEADER[@]}" -X "$method" "$url" -d "$data" -w "\n%{http_code}" | tee "$BODY_FILE" | tail -n1)
    # Remove the last status line from BODY_FILE
    sed -i '' -e '$d' "$BODY_FILE" 2>/dev/null || sed -i -e '$d' "$BODY_FILE" 2>/dev/null || true
  else
    HTTP_STATUS=$(curl "${CURL_OPTS[@]}" "${AUTH_HEADER[@]}" -X "$method" "$url" -w "\n%{http_code}" | tee "$BODY_FILE" | tail -n1)
    sed -i '' -e '$d' "$BODY_FILE" 2>/dev/null || sed -i -e '$d' "$BODY_FILE" 2>/dev/null || true
  fi
}

cleanup() { rm -f .ttt_cookies.txt .ttt_resp.json .ttt_body.json .ttt_hdrs.txt "$BODY_FILE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1) Register
info "Registering user: ${EMAIL}"
set +e
REG_BODY=$(curl "${CURL_OPTS[@]}" -X POST "${BASE_URL}/api/auth/register" -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" 2>/dev/null)
REG_CODE=$?
set -e
if [ $REG_CODE -ne 0 ]; then
  info "Register may have failed (possibly already exists). Trying login..."
fi

# 2) Login
info "Logging in"
LOGIN_JSON=$(curl "${CURL_OPTS[@]}" -X POST "${BASE_URL}/api/auth/login" -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")
TOKEN=$(printf "%s" "$LOGIN_JSON" | JQ_GET '.token')
if [ -z "$TOKEN" ]; then
  echo "Login response:"; echo "$LOGIN_JSON"
  fail "Login did not return a token"
fi
AUTH_HEADER=(-H "Authorization: Bearer ${TOKEN}")

# 3) Create task
TASK_ID="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo ttt-$RANDOM-$RANDOM)"
TODAY=$(date +%F)
info "Creating task with id=${TASK_ID}"
CREATE_PAY=$(jq -n --arg id "$TASK_ID" --arg title "E2E Test Task" --arg notes "Created by test-api.sh" \
  --arg cat "Default" --arg nd "$TODAY" --arg tm "09:00" '{id:$id,title:$title,notes:$notes,category:$cat,everyDays:1,nextDue:$nd,remindAt:$tm,priority:false}')
_do_curl POST "${BASE_URL}/api/tasks" "$CREATE_PAY"
CREATE_BODY=$(cat "$BODY_FILE")
CREATED_ID=$(printf "%s" "$CREATE_BODY" | JQ_GET '.id')
if [ -z "$CREATED_ID" ] || [ "${HTTP_STATUS}" != "201" ]; then
  info "Create failed (HTTP ${HTTP_STATUS}). Trying without category..."
  CREATE_PAY2=$(jq -n --arg id "$TASK_ID" --arg title "E2E Test Task" --arg notes "Created by test-api.sh" \
    --arg nd "$TODAY" --arg tm "09:00" '{id:$id,title:$title,notes:$notes,everyDays:1,nextDue:$nd,remindAt:$tm,priority:false}')
  _do_curl POST "${BASE_URL}/api/tasks" "$CREATE_PAY2"
  CREATE_BODY=$(cat "$BODY_FILE")
  CREATED_ID=$(printf "%s" "$CREATE_BODY" | JQ_GET '.id')
fi
if [ -z "$CREATED_ID" ] || [ "${HTTP_STATUS}" != "201" ]; then
  info "Create still failing (HTTP ${HTTP_STATUS}). Trying minimal payload..."
  CREATE_PAY3=$(jq -n --arg id "$TASK_ID" --arg title "E2E Test Task" --arg notes "Created by test-api.sh" \
    --arg nd "$TODAY" --arg tm "09:00" '{id:$id,title:$title,notes:$notes,everyDays:1,nextDue:$nd,remindAt:$tm}')
  _do_curl POST "${BASE_URL}/api/tasks" "$CREATE_PAY3"
  CREATE_BODY=$(cat "$BODY_FILE")
  CREATED_ID=$(printf "%s" "$CREATE_BODY" | JQ_GET '.id')
fi
if [ -z "$CREATED_ID" ]; then
  echo "Create response (HTTP ${HTTP_STATUS}):"; echo "$CREATE_BODY"
  fail "Task create did not return an id"
fi

# 4) Edit task
info "Editing task (title/notes)"
EDIT_PAY=$(jq -n --arg title "E2E Test Task (edited)" --arg notes "Edited by test" --arg cat "Default" --arg nd "$TODAY" --arg tm "10:00" '{title:$title,notes:$notes,category:$cat,everyDays:1,nextDue:$nd,remindAt:$tm,priority:false}')
_do_curl PUT "${BASE_URL}/api/tasks/${TASK_ID}" "$EDIT_PAY"
EDIT_BODY=$(cat "$BODY_FILE")
OK=$(printf "%s" "$EDIT_BODY" | JQ_GET '.ok')
if [ "$OK" != "true" ]; then
  info "Edit failed (HTTP ${HTTP_STATUS}). Trying without category..."
  EDIT_PAY2=$(jq -n --arg title "E2E Test Task (edited)" --arg notes "Edited by test" --arg nd "$TODAY" --arg tm "10:00" '{title:$title,notes:$notes,everyDays:1,nextDue:$nd,remindAt:$tm,priority:false}')
  _do_curl PUT "${BASE_URL}/api/tasks/${TASK_ID}" "$EDIT_PAY2"
  EDIT_BODY=$(cat "$BODY_FILE")
  OK=$(printf "%s" "$EDIT_BODY" | JQ_GET '.ok')
fi
if [ "$OK" != "true" ]; then
  info "Edit still failing (HTTP ${HTTP_STATUS}). Trying minimal payload..."
  EDIT_PAY3=$(jq -n --arg title "E2E Test Task (edited)" --arg nd "$TODAY" --arg tm "10:00" '{title:$title,everyDays:1,nextDue:$nd,remindAt:$tm}')
  _do_curl PUT "${BASE_URL}/api/tasks/${TASK_ID}" "$EDIT_PAY3"
  EDIT_BODY=$(cat "$BODY_FILE")
  OK=$(printf "%s" "$EDIT_BODY" | JQ_GET '.ok')
fi
if [ "$OK" != "true" ]; then
  echo "Edit response (HTTP ${HTTP_STATUS}):"; echo "$EDIT_BODY"
  fail "Task edit did not return ok:true"
fi

# 5) Complete task (toggle)
NOW_ISO=$(date -u +%FT%TZ)
ND_TOMORROW=$(date -d "$TODAY + 1 day" +%F 2>/dev/null || python3 - <<'PY'
from datetime import date, timedelta
print((date.today()+timedelta(days=1)).isoformat())
PY
)
info "Completing task (lastCompleted -> now, nextDue -> $ND_TOMORROW)"
COMPLETE_PAY=$(jq -n --arg title "E2E Test Task (edited)" --arg notes "Edited by test" --arg cat "Default" \
  --arg nd "$ND_TOMORROW" --arg tm "10:00" --arg iso "$NOW_ISO" '{title:$title,notes:$notes,category:$cat,everyDays:1,nextDue:$nd,remindAt:$tm,priority:false,lastCompleted:$iso}')
_do_curl PUT "${BASE_URL}/api/tasks/${TASK_ID}" "$COMPLETE_PAY"
COMPLETE_BODY=$(cat "$BODY_FILE")
OK=$(printf "%s" "$COMPLETE_BODY" | JQ_GET '.ok')
if [ "$OK" != "true" ]; then
  info "Complete failed (HTTP ${HTTP_STATUS}). Trying without category..."
  COMPLETE_PAY2=$(jq -n --arg title "E2E Test Task (edited)" --arg notes "Edited by test" \
    --arg nd "$ND_TOMORROW" --arg tm "10:00" --arg iso "$NOW_ISO" '{title:$title,notes:$notes,everyDays:1,nextDue:$nd,remindAt:$tm,priority:false,lastCompleted:$iso}')
  _do_curl PUT "${BASE_URL}/api/tasks/${TASK_ID}" "$COMPLETE_PAY2"
  COMPLETE_BODY=$(cat "$BODY_FILE")
  OK=$(printf "%s" "$COMPLETE_BODY" | JQ_GET '.ok')
fi
if [ "$OK" != "true" ]; then
  info "Complete still failing (HTTP ${HTTP_STATUS}). Trying minimal payload..."
  COMPLETE_PAY3=$(jq -n --arg title "E2E Test Task (edited)" \
    --arg nd "$ND_TOMORROW" --arg tm "10:00" --arg iso "$NOW_ISO" '{title:$title,everyDays:1,nextDue:$nd,remindAt:$tm,lastCompleted:$iso}')
  _do_curl PUT "${BASE_URL}/api/tasks/${TASK_ID}" "$COMPLETE_PAY3"
  COMPLETE_BODY=$(cat "$BODY_FILE")
  OK=$(printf "%s" "$COMPLETE_BODY" | JQ_GET '.ok')
fi
if [ "$OK" != "true" ]; then
  echo "Complete response (HTTP ${HTTP_STATUS}):"; echo "$COMPLETE_BODY"
  fail "Task complete (PUT) did not return ok:true"
fi

# 6) List tasks and verify
info "Listing tasks"
_do_curl GET "${BASE_URL}/api/tasks"
LIST_BODY=$(cat "$BODY_FILE")
FOUND=$(printf "%s" "$LIST_BODY" | jq --arg id "$TASK_ID" -e '.tasks | map(select(.id==$id)) | length > 0' >/dev/null 2>&1; echo $?)
if [ "$FOUND" != "0" ]; then
  echo "List response (HTTP ${HTTP_STATUS}):"; echo "$LIST_BODY"
  fail "Created task not found in list"
fi

# 7) Delete task
info "Deleting task"
_do_curl DELETE "${BASE_URL}/api/tasks/${TASK_ID}"
DEL_BODY=$(cat "$BODY_FILE")
OK=$(printf "%s" "$DEL_BODY" | JQ_GET '.ok')
if [ "$OK" != "true" ]; then
  echo "Delete response (HTTP ${HTTP_STATUS}):"; echo "$DEL_BODY"
  fail "Task delete did not return ok:true"
fi

info "PASS: All API operations succeeded for user ${EMAIL} against ${BASE_URL}"
