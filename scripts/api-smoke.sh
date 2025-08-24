#!/usr/bin/env bash
# Simple API smoke test for TickTock backend (cookie-based web flow)
# Usage: scripts/api-smoke.sh [BACKEND_URL]
# Example: scripts/api-smoke.sh https://api.example.com

BE_URL="${1:-}"
if [ -z "$BE_URL" ]; then
  echo "api-smoke: BACKEND_URL is required";
  exit 0
fi

TMP_DIR="$(mktemp -d)"
COOKIE_JAR="$TMP_DIR/cookies.txt"
EMAIL="ci-$(date +%s)@example.test"
PASS="Passw0rd!123"

print_h() { printf "\n== %s ==\n" "$1"; }
http() {
  # $1: method, $2: path, $3: data-json-or-empty
  local m="$1"; shift
  local p="$1"; shift
  local d="${1:-}"
  if [ -n "$d" ]; then
    curl -isk -X "$m" "$BE_URL$p" \
      -H 'Content-Type: application/json' \
      -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
      --data "$d"
  else
    curl -isk -X "$m" "$BE_URL$p" \
      -H 'Content-Type: application/json' \
      -c "$COOKIE_JAR" -b "$COOKIE_JAR"
  fi
}

print_h "Health check ${BE_URL}/healthz"
http GET "/healthz" | sed -n '1,20p'

print_h "Attempt register ${EMAIL}"
RESP=$(http POST "/api/auth/register" "{\"email\":\"${EMAIL}\",\"password\":\"${PASS}\"}")
CODE=$(printf "%s" "$RESP" | sed -n '1s/.* \([0-9][0-9][0-9]\).*/\1/p')
if [ "$CODE" = "409" ]; then
  print_h "User exists, trying login"
  http POST "/api/auth/login" "{\"email\":\"${EMAIL}\",\"password\":\"${PASS}\"}" | sed -n '1,20p'
else
  printf "%s" "$RESP" | sed -n '1,20p'
fi

print_h "Get /api/auth/me"
http GET "/api/auth/me" | sed -n '1,40p'

TID="smk-$(date +%s)"
NOW_DATE=$(date -u +%Y-%m-%d)
print_h "Create task ${TID}"
http POST "/api/tasks" "{\"id\":\"${TID}\",\"title\":\"Smoke Task\",\"notes\":\"CI smoke\",\"everyDays\":1,\"nextDue\":\"${NOW_DATE}\",\"remindAt\":\"09:00\",\"priority\":false}" | sed -n '1,40p'

print_h "List tasks"
http GET "/api/tasks" | sed -n '1,60p'

rm -rf "$TMP_DIR" 2>/dev/null || true
exit 0
