#!/usr/bin/env bash
# Idempotent backend nudge to ensure Caddy is correctly attached to the backend network and proxying.
# Intended to run on the EC2 host via SSM.
# Safe to run multiple times.
set -euo pipefail

log() { printf "[%s] %s\n" "$(date -u +%FT%TZ)" "$*"; }

cd /opt/ticktock 2>/dev/null || cd "$(dirname "$0")/.." || true

log "git pull"
if [ -d .git ]; then git pull --rebase || true; fi

# Prefer compose plugin; fall back to docker-compose if present
HAS_PLUGIN=false
if docker compose version >/dev/null 2>&1; then HAS_PLUGIN=true; fi

log "compose pull (if plugin available)"
if $HAS_PLUGIN; then docker compose pull || true; fi

log "remove stray caddy/autoheal to avoid name conflicts"
docker rm -f ticktock-caddy ticktock-autoheal 2>/dev/null || true

# Ensure Caddyfile (host-mounted)
API_SUBDOMAIN=${API_SUBDOMAIN:-api}
DOMAIN_NAME=${DOMAIN_NAME:-ticktocktasks.com}
APIDOM=${APIDOM:-${API_SUBDOMAIN}.${DOMAIN_NAME}}
CADDYFILE=/opt/ticktock/Caddyfile

# If a directory named Caddyfile exists, remove it (it breaks mount)
if [ -d "$CADDYFILE" ]; then rm -rf "$CADDYFILE" || true; fi

log "write Caddyfile for ${API_SUBDOMAIN}.${DOMAIN_NAME}"
cat > "$CADDYFILE" <<CFG
${API_SUBDOMAIN}.${DOMAIN_NAME} {
  encode gzip
  tls admin@${DOMAIN_NAME}
  reverse_proxy http://backend:8080
}
CFG

log "docker compose up -d (start/ensure backend + caddy)"
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d || true
else
  docker compose up -d || true
fi

# If compose didn't bring up caddy (older compose, overrides, etc.), start it manually on backend network
if ! docker ps --format '{{.Names}}' | grep -q '^ticktock-caddy$'; then
  log "caddy not found after compose; starting manually on compose network"
  BACK_NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' ticktock-backend 2>/dev/null || true)
  if [ -z "$BACK_NET" ]; then
    # best-effort: find a compose _default network
    BACK_NET=$(docker network ls --format '{{.Name}}' | grep '_default$' | head -n1 || true)
  fi
  docker volume create caddy_data >/dev/null 2>&1 || true
  if [ -n "$BACK_NET" ]; then
    docker run -d --name ticktock-caddy --network "$BACK_NET" -p 80:80 -p 443:443 \
      -v "$CADDYFILE":/etc/caddy/Caddyfile -v caddy_data:/data --restart unless-stopped caddy:2 || true
  else
    docker run -d --name ticktock-caddy -p 80:80 -p 443:443 \
      -v "$CADDYFILE":/etc/caddy/Caddyfile -v caddy_data:/data --restart unless-stopped caddy:2 || true
  fi
  # ensure connected to backend network if known
  if [ -n "$BACK_NET" ]; then docker network connect "$BACK_NET" ticktock-caddy 2>/dev/null || true; fi
fi

# Diagnostics
log "docker ps"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true

log "listening sockets"
ss -ltnp | egrep ':(80|443|8080|8443)' || true

log "caddy via localhost test"
curl -sk --max-time 10 -H "Host: ${API_SUBDOMAIN}.${DOMAIN_NAME}" http://127.0.0.1/healthz || true

log "caddy logs (last 160)"
docker logs --tail=160 ticktock-caddy 2>&1 || true

log "backend logs (last 160)"
docker logs --tail=160 ticktock-backend 2>&1 || true

log "localhost backend health"
curl -sS --max-time 6 http://localhost:8080/healthz || true

log "done"
