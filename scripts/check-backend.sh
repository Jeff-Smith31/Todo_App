#!/usr/bin/env bash
# Quick connectivity diagnostics for TickTock Tasks backend
# Usage: ./scripts/check-backend.sh ticktocktasks.com
# Optionally set API_SUB=www.api (default)
set -euo pipefail
DOMAIN=${1:-}
API_SUB=${API_SUB:-www.api}
if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain>" >&2
  exit 2
fi
API_HOST="${API_SUB}.${DOMAIN}"
WWW_HOST="www.${DOMAIN}"

echo "=== DNS ==="
host "$WWW_HOST" || true
host "$API_HOST" || true

try() { echo "\n-- $*"; bash -lc "$*" || true; }

UA="TickTockTasks-Diag/2.0"

echo "\n=== Public checks ==="
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' http://${WWW_HOST}/ -m 10 -w '\nHTTP %{http_code}\n'"
try "curl -fsS -A '$UA' -H 'Cache-Control: no-cache' http://${API_HOST}/healthz -m 10 -w '\nHTTP %{http_code}\n'"
