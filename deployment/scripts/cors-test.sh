#!/usr/bin/env bash
set -euo pipefail
# Usage: scripts/cors-test.sh [BACKEND_URL] [ORIGIN]
# Example (dev): scripts/cors-test.sh http://localhost:8080 http://localhost:8000
# Example (prod): scripts/cors-test.sh https://api.your-domain.com https://your-domain.com

BE="${1:-http://localhost:8080}"
ORIGIN="${2:-http://localhost:8000}"

printf "\n== Preflight OPTIONS from %s to %s/api/auth/login ==\n" "$ORIGIN" "$BE"
curl -isk -X OPTIONS "$BE/api/auth/login" \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type,Authorization" | sed -n '1,40p'

printf "\n== Health check GET from %s to %s/healthz ==\n" "$ORIGIN" "$BE"
curl -isk "$BE/healthz" -H "Origin: $ORIGIN" | sed -n '1,40p'

cat <<EOF

Notes:
- Access-Control-Allow-Origin should echo your ORIGIN and Access-Control-Allow-Credentials: true should be present.
- If the preflight shows 204 and the health check is 200 with the proper CORS headers, the frontend fetch() should succeed.
EOF
