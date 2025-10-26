#!/usr/bin/env bash
# Quick connectivity diagnostics for TickTock Tasks backend
# Usage: ./scripts/check-backend.sh ticktocktasks.com
# Optionally set API_SUB=api (default)
set -euo pipefail
DOMAIN=${1:-}
API_SUB=${API_SUB:-api}
if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain>" >&2
  exit 2
fi
API_HOST="${API_SUB}.${DOMAIN}"

echo "=== DNS ==="
host "$DOMAIN" || true
host "$API_HOST" || true

try() { echo "\n-- $*"; bash -lc "$*" || true; }

UA="TickTockTasks-Diag/1.0"

echo "\n=== Public checks ==="
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' https://${DOMAIN}/api/healthz -m 10 -w '\nHTTP %{http_code}\n'"
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' https://${API_HOST}/healthz -m 10 -w '\nHTTP %{http_code}\n'"
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' http://${API_HOST}/healthz -m 10 -w '\nHTTP %{http_code}\n'"

echo "\nIf the CloudFront path (/api/healthz) fails but direct API works over HTTP, ensure frontend BACKEND_URL is empty (same-origin) and CloudFront behavior for /api/* is active."
