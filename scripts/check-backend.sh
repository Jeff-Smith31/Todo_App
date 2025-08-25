#!/usr/bin/env bash
set -euo pipefail
# Quick backend health confirm. Tries /api/ping and /healthz and prints diagnostics.
# Usage:
#   scripts/check-backend.sh [BACKEND_URL]
# If BACKEND_URL is not provided, attempts to resolve from CloudFormation backend stack outputs.
# Env overrides:
#   BACKEND_STACK_NAME (default: ttt-backend)
#   BACKEND_REGION (default: aws configure get region or us-east-1)

url_from_stack() {
  local stack="${BACKEND_STACK_NAME:-ttt-backend}"
  local region="${BACKEND_REGION:-$(aws configure get region || echo us-east-1)}"
  aws cloudformation describe-stacks \
    --region "$region" \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='BackendEndpoint'].OutputValue | [0]" \
    --output text 2>/dev/null || true
}

BE_URL="${1:-}"
if [ -z "$BE_URL" ]; then
  if command -v aws >/dev/null 2>&1; then
    BE_URL="$(url_from_stack)"
  fi
fi

if [ -z "$BE_URL" ] || [ "$BE_URL" = "None" ]; then
  echo "[check-backend] Backend URL not provided and could not be resolved from stack."
  echo "Provide BACKEND_URL explicitly, e.g.: scripts/check-backend.sh https://api.your-domain.com"
  exit 2
fi

# Normalize (no trailing slash)
BE_URL="${BE_URL%/}"
HOST=$(printf "%s" "$BE_URL" | sed -E 's#^https?://([^/]+).*#\1#')

curl_status() {
  local path="$1"
  curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "${BE_URL}${path}" || echo "000"
}

JGET() { python3 - "$@" <<'PY'
import json,sys
try:
  print(json.load(sys.stdin).get(sys.argv[1],''))
except Exception:
  print('')
PY
}

pass_any=0

printf "Checking %s/healthz ...\n" "$BE_URL"
HC_CODE=$(curl_status "/healthz")
if [ "$HC_CODE" = "200" ]; then
  echo "OK /healthz (200)"
  pass_any=1
else
  echo "FAIL /healthz (HTTP $HC_CODE)"
fi

printf "Checking %s/api/ping ...\n" "$BE_URL"
PING_CODE=$(curl -sk --max-time 10 "${BE_URL}/api/ping" -w "\n%{http_code}" 2>/dev/null)
PING_BODY=$(printf "%s" "$PING_CODE" | sed '$d')
PING_HTTP=$(printf "%s" "$PING_CODE" | tail -n1)
if [ "$PING_HTTP" = "200" ]; then
  svc=$(printf "%s" "$PING_BODY" | JGET service)
  echo "OK /api/ping (200) service=${svc:-unknown}"
  pass_any=1
else
  echo "FAIL /api/ping (HTTP $PING_HTTP)"
  echo "Body (truncated): $(printf "%s" "$PING_BODY" | head -c 140)"
fi

# Extra diagnostics on failure: DNS, raw IP Host-header curl, and TLS check
if [ "$pass_any" -ne 1 ]; then
  echo
  echo "--- Diagnostics ---"
  if command -v dig >/dev/null 2>&1; then
    echo "DNS (dig +short ${HOST})"
    dig +short "$HOST" || true
  else
    echo "Install dnsutils to run dig for DNS diagnostics."
  fi
  if command -v getent >/dev/null 2>&1; then
    echo "getent hosts ${HOST}:"
    getent hosts "$HOST" || true
  fi
  IP=$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1; exit}' || true)
  if [ -n "$IP" ]; then
    echo "Trying direct IP with Host header: ${IP} (Host: ${HOST})"
    curl -skI --max-time 8 "https://${IP}/healthz" -H "Host: ${HOST}" || true
  fi
  if command -v openssl >/dev/null 2>&1; then
    echo "TLS ServerHello (openssl s_client -servername ${HOST})"
    printf "\n" | openssl s_client -connect "${HOST}:443" -servername "$HOST" -brief -no_ign_eof 2>/dev/null | sed -n '1,40p' || true
  fi
fi

if [ "$pass_any" -eq 1 ]; then
  echo "[check-backend] PASS: backend is reachable."
  exit 0
else
  echo "[check-backend] FAIL: backend unreachable or unhealthy."
  exit 1
fi
