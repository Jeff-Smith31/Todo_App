#!/usr/bin/env bash
# Quick connectivity diagnostics for TickTock Tasks frontend and backend
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
WWW_HOST="${DOMAIN}"
WWW_WWW_HOST="www.${DOMAIN}"
WWW_API_HOST="www.${API_SUB}.${DOMAIN}"

echo "=== DNS ==="
host "$WWW_HOST" || true
host "$API_HOST" || true
host "$WWW_WWW_HOST" || true
host "$WWW_API_HOST" || true

try() { echo "\n-- $*"; bash -lc "$*" || true; }

UA="TickTockTasks-Diag/3.0"

echo "\n=== HTTP checks (expect 301 redirect to HTTPS) ==="
try "curl -fsS -I -A '$UA' -H 'Cache-Control: no-cache' http://${WWW_HOST}/ -m 10"
try "curl -fsS -I -A '$UA' -H 'Cache-Control: no-cache' http://${WWW_WWW_HOST}/ -m 10"
try "curl -fsS -I -A '$UA' -H 'Cache-Control: no-cache' http://${API_HOST}/ -m 10"
try "curl -fsS -I -A '$UA' -H 'Cache-Control: no-cache' http://${WWW_API_HOST}/ -m 10"

echo "\n=== HTTPS checks (frontend root) ==="
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' https://${WWW_HOST}/ -m 15 -w '\nHTTP %{http_code}\n'"
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' https://${WWW_WWW_HOST}/ -m 15 -w '\nHTTP %{http_code}\n'"

echo "\n=== HTTPS checks (backend health) ==="
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' https://${API_HOST}/healthz -m 15 -w '\nHTTP %{http_code}\n'"
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' https://${WWW_API_HOST}/healthz -m 15 -w '\nHTTP %{http_code}\n'"
