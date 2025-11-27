#!/usr/bin/env bash
# Quick login endpoint checks to help diagnose 404 vs 401 on TickTock Tasks
# Usage: ./scripts/check-login.sh ticktocktasks.com [api-subdomain]
set -euo pipefail
DOMAIN=${1:-}
API_SUB=${2:-api}
if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain> [api-subdomain]" >&2
  exit 2
fi
API_HOST="${API_SUB}.${DOMAIN}"
UA="TickTockTasks-LoginDiag/1.0"

echo "=== Checking login endpoints for domain: $DOMAIN (api sub: $API_SUB) ==="
post() {
  local url="$1"
  echo -e "\n-- POST $url"
  curl -isk -A "$UA" -H 'Content-Type: application/json' \
    -d '{"email":"nobody@example.com","password":"wrongpass"}' \
    "$url" | sed -n '1,12p'
}

# Expect 401 Unauthorized from backend; 404 indicates routing problem
post "https://${API_HOST}/api/auth/login"
post "https://${API_HOST}/auth/login"
post "https://${DOMAIN}/api/auth/login"

# Also test HTTP->HTTPS redirect paths
echo -e "\n=== HTTP redirect checks ==="
curl -fsS -I -A "$UA" "http://${API_HOST}/auth/login" | sed -n '1,6p' || true
curl -fsS -I -A "$UA" "http://${DOMAIN}/api/auth/login" | sed -n '1,6p' || true
