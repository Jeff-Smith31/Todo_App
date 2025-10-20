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

# Preflight: verify ACME webroot is being served by nginx
PROBE_FILE="/var/www/certbot/.well-known/acme-challenge/_ttt_probe_$(date +%s)"
echo "Performing ACME webroot preflight checks ..."
# Create probe file inside nginx container and verify local reachability
"${COMPOSE_CMD[@]}" exec -T nginx sh -lc "mkdir -p \"$(dirname \"$PROBE_FILE\")\" && echo ok > \"$PROBE_FILE\"" || {
  echo "Preflight failed: could not create probe file in nginx webroot" >&2
  exit 20
}
"${COMPOSE_CMD[@]}" exec -T nginx sh -lc "wget -qO- http://127.0.0.1/.well-known/acme-challenge/$(basename \"$PROBE_FILE\")" >/dev/null || {
  echo "Preflight failed: nginx did not serve probe file locally. Check nginx container health and nginx.conf location for /.well-known" >&2
  exit 21
}
# Public reachability (DNS + Security Group): test from the EC2 host to api.<domain>
if curl -fsS --max-time 10 "http://api.${DOMAIN}/.well-known/acme-challenge/$(basename \"$PROBE_FILE\")" >/dev/null; then
  echo "Preflight OK: api.${DOMAIN} serves ACME challenges"
else
  echo "WARNING: Public reachability preflight failed for http://api.${DOMAIN}/.well-known/acme-challenge/$(basename \"$PROBE_FILE\")." >&2
  echo "This usually indicates DNS is not pointing to this EC2 host, or TCP/80 is blocked by Security Group/Firewall." >&2
  echo "Proceeding anyway so certbot can emit detailed errors..." >&2
fi

# Build optional certbot flags
CERTBOT_OPTS=(--keep-until-expiring --expand)
if [ "${CERT_STAGING:-0}" = "1" ]; then
  echo "Using Let's Encrypt staging environment (CERT_STAGING=1)"
  CERTBOT_OPTS+=(--staging)
fi

# Run certbot (webroot)
"${COMPOSE_CMD[@]}" run --rm -T --no-deps \
  --entrypoint certbot \
  -e CERTBOT_EMAIL="${EMAIL}" \
  certbot \
  certonly --webroot \
  -w /var/www/certbot \
  --email "${EMAIL}" \
  --agree-tos -n \
  "${CERTBOT_OPTS[@]}" \
  "${DOMS[@]}"

# Show resulting cert directories for visibility
"${COMPOSE_CMD[@]}" run --rm --no-deps --entrypoint sh certbot -lc 'ls -l /etc/letsencrypt/live || true; ls -l /etc/letsencrypt/archive || true' || true

# Validate nginx config and reload to pick up new/renewed certs
set +e
"${COMPOSE_CMD[@]}" exec -T nginx nginx -t
NGINX_TEST=$?
if [ "$NGINX_TEST" -ne 0 ]; then
  echo "Nginx config test failed; attempting restart to apply any changes anyway" >&2
fi
"${COMPOSE_CMD[@]}" exec -T nginx nginx -s reload || "${COMPOSE_CMD[@]}" restart nginx
set -e

echo "Certificates issued/renewed for: ${DOMAIN}, www.${DOMAIN}${INCLUDE_API:+, api.${DOMAIN}}"
