#!/usr/bin/env bash
# Idempotent backend nudge to ensure Nginx is correctly attached to the backend network and proxying with TLS.
# Intended to run on the EC2 host via SSM.
# Safe to run multiple times.
set -euo pipefail

log() { printf "[%s] %s\n" "$(date -u +%FT%TZ)" "$*"; }

cd /opt/ticktock 2>/dev/null || cd "$(dirname "$0")/.." || true

log "git sync (fetch + reset --hard origin/main)"
if [ -d .git ]; then 
  git fetch --all --prune || true
  git reset --hard origin/main || true
  # keep local .env intact
  git clean -fd -e .env || true
fi

# Prefer compose plugin; fall back to docker-compose if present
HAS_PLUGIN=false
if docker compose version >/dev/null 2>&1; then HAS_PLUGIN=true; fi

log "compose pull (if plugin available)"
if $HAS_PLUGIN; then docker compose pull || true; fi

log "remove stray proxy/autoheal to avoid name conflicts"
docker rm -f ttt-nginx ttt-autoheal ttt-certbot ticktock-nginx ticktock-autoheal ticktock-certbot ticktock-caddy 2>/dev/null || true

# Ensure nginx.conf (host-mounted)
API_SUBDOMAIN=${API_SUBDOMAIN:-api}
DOMAIN_NAME=${DOMAIN_NAME:-ticktocktasks.com}
APIDOM=${APIDOM:-${API_SUBDOMAIN}.${DOMAIN_NAME}}
NGINX_CONF=/opt/ticktock/nginx.conf

# Ensure .env contains required runtime vars (especially DDB_REGION)
REGION_GUESS=${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}
if [ -f .env ]; then
  if grep -q '^DDB_REGION=' .env; then
    sed -i "s#^DDB_REGION=.*#DDB_REGION=${REGION_GUESS}#" .env || true
  else
    echo "DDB_REGION=${REGION_GUESS}" >> .env
  fi
  if grep -q '^REDIRECT_HTTP_TO_HTTPS=' .env; then
    sed -i 's#^REDIRECT_HTTP_TO_HTTPS=.*#REDIRECT_HTTP_TO_HTTPS=false#' .env || true
  else
    echo 'REDIRECT_HTTP_TO_HTTPS=false' >> .env
  fi
else
  cat > .env <<ENV
CORS_ORIGIN=https://${DOMAIN_NAME},https://www.${DOMAIN_NAME}
JWT_SECRET=$(openssl rand -hex 24 2>/dev/null || echo dev-secret)
NODE_ENV=production
REDIRECT_HTTP_TO_HTTPS=false
DDB_REGION=${REGION_GUESS}
ENV
fi

# Build or rebuild backend image to pick up latest code
log "build backend image"
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose build backend || true
else
  docker compose build backend || true
fi

log "ensure docker-compose.override.yml defines nginx/certbot/autoheal"
cat > /opt/ticktock/docker-compose.override.yml <<'OVR'
version: '3.8'
services:
  nginx:
    image: nginx:alpine
    container_name: ttt-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /opt/ticktock/nginx.conf:/etc/nginx/nginx.conf
      - letsencrypt:/etc/letsencrypt
      - certbot_challenges:/var/www/certbot
    depends_on:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- --no-check-certificate https://127.0.0.1/healthz >/dev/null || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
  certbot:
    image: certbot/certbot
    container_name: ttt-certbot
    volumes:
      - letsencrypt:/etc/letsencrypt
      - certbot_challenges:/var/www/certbot
  autoheal:
    image: willfarrell/autoheal
    container_name: ttt-autoheal
    restart: unless-stopped
    environment:
      - AUTOHEAL_CONTAINER_LABEL=all
      - AUTOHEAL_INTERVAL=10
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
volumes:
  letsencrypt:
  certbot_challenges:
OVR

log "write initial HTTP nginx.conf for ${APIDOM}"
cat > "$NGINX_CONF" <<CFG
user  nginx;
worker_processes  auto;
error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;
events { worker_connections 1024; }
http {
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;
  sendfile        on;
  keepalive_timeout 65;
  upstream ticktock_backend { server backend:8080; }
  server {
    listen 80 default_server;
    server_name ${APIDOM};
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; default_type "text/plain"; }
    location = /healthz { proxy_set_header Host \$host; proxy_pass http://ticktock_backend/healthz; }
    location / {
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_pass http://ticktock_backend;
    }
  }
}
CFG

log "docker compose up -d (start/ensure backend + nginx)"
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose rm -sf backend || true
  docker-compose up -d backend || true
  docker-compose up -d nginx autoheal certbot || true
else
  docker compose rm -sf backend || true
  docker compose up -d backend || true
  docker compose up -d nginx autoheal certbot || true
fi

# Obtain or renew certs using certbot (webroot)
log "attempting certbot issuance for ${APIDOM}"
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose run --rm certbot certonly --webroot -w /var/www/certbot -d "${APIDOM}" --agree-tos --email "admin@${DOMAIN_NAME}" -n || true
else
  docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d "${APIDOM}" --agree-tos --email "admin@${DOMAIN_NAME}" -n || true
fi


log "write HTTPS nginx.conf"
cat > "$NGINX_CONF" <<CFG
user  nginx;
worker_processes  auto;
error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;
events { worker_connections 1024; }
http {
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;
  sendfile        on;
  keepalive_timeout 65;
  upstream ticktock_backend { server backend:8080; }
  server {
    listen 80;
    server_name ${APIDOM};
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; default_type "text/plain"; }
    return 301 https://\$host\$request_uri;
  }
  server {
    listen 443 ssl http2;
    server_name ${APIDOM};
    client_max_body_size 2m;
    ssl_certificate /etc/letsencrypt/live/${APIDOM}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${APIDOM}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    location = /healthz { proxy_set_header Host \$host; proxy_pass http://ticktock_backend/healthz; }
    location / {
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_read_timeout 60s;
      proxy_send_timeout 60s;
      proxy_pass http://ticktock_backend;
    }
  }
}
CFG

# Reload Nginx (or restart if reload fails)
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose exec -T nginx nginx -s reload || docker-compose restart nginx || true
else
  docker compose exec -T nginx nginx -s reload || docker compose restart nginx || true
fi

# Diagnostics
log "docker ps"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true

log "listening sockets"
ss -ltnp | egrep ':(80|443|8080|8443)' || true

log "nginx via localhost test"
curl -sk --max-time 10 https://127.0.0.1/healthz || true

log "nginx logs (last 160)"
docker logs --tail=160 ttt-nginx 2>&1 || true

log "backend logs (last 160)"
docker logs --tail=160 ttt-backend 2>&1 || true

log "localhost backend health"
curl -sS --max-time 6 http://localhost:8080/healthz || true

log "done"
