#!/usr/bin/env bash
set -euo pipefail

# Obtain/renew Let's Encrypt certificates for TickTock Tasks on a single EC2 host.
# This uses the certbot container defined in docker-compose with the webroot
# /.well-known/acme-challenge served by Nginx from /var/www/certbot.
#
# Usage examples:
#   scripts/issue-certs.sh ticktocktasks.com           # issues cert for apex + www
#   scripts/issue-certs.sh ticktocktasks.com --include-api   # also issues api.<domain>
#   EMAIL=admin@ticktocktasks.com scripts/issue-certs.sh ticktocktasks.com
#
# After a successful issuance/renewal, Nginx will be reloaded.

DOMAIN=${1:?'Domain required, e.g., ticktocktasks.com'}
INCLUDE_API=${2:-}
EMAIL=${EMAIL:-"admin@${DOMAIN}"}

# Detect compose command: prefer Docker Compose v2 (docker compose), fallback to v1 (docker-compose)
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' is available on this host." >&2
  exit 1
fi

# Build domain args
DOMS=("-d" "${DOMAIN}" "-d" "www.${DOMAIN}")
if [ "${INCLUDE_API}" = "--include-api" ]; then
  DOMS+=("-d" "api.${DOMAIN}")
fi

# Ensure nginx is up to answer HTTP challenges (idempotent)
echo "Bringing up nginx to serve ACME challenges ..."
"${COMPOSE_CMD[@]}" up -d nginx

# Run certbot (webroot)
"${COMPOSE_CMD[@]}" run --rm \
  -e CERTBOT_EMAIL="${EMAIL}" \
  certbot certonly --webroot \
  -w /var/www/certbot \
  --email "${EMAIL}" \
  --agree-tos -n \
  "${DOMS[@]}"

# Reload Nginx to pick up new/renewed certs
set +e
"${COMPOSE_CMD[@]}" exec -T nginx nginx -s reload || "${COMPOSE_CMD[@]}" restart nginx
set -e

echo "Certificates issued/renewed for: ${DOMAIN}, www.${DOMAIN}${INCLUDE_API:+, api.${DOMAIN}}"
