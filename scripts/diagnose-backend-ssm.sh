#!/usr/bin/env bash
set -euo pipefail
# Diagnose backend EC2 host via SSM. Gathers docker status, ports, Caddyfile, logs, and local health.
# Usage:
#   scripts/diagnose-backend-ssm.sh [--repair] [BACKEND_STACK_NAME] [REGION]
# Defaults:
#   BACKEND_STACK_NAME: ${BACKEND_STACK_NAME:-ttt-backend}
#   REGION: ${BACKEND_REGION or aws configure get region or us-east-1}
# Requires: AWS CLI v2 with permissions for SSM and CloudFormation.

REPAIR=false
if [ "${1:-}" = "--repair" ]; then
  REPAIR=true
  shift
fi

STACK_NAME="${1:-${BACKEND_STACK_NAME:-ttt-backend}}"
REGION="${2:-${BACKEND_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }
grn() { printf "\033[32m%s\033[0m\n" "$*"; }
blu() { printf "\033[34m%s\033[0m\n" "$*"; }

if ! command -v aws >/dev/null 2>&1; then
  red "AWS CLI is required. Install and configure credentials."
  exit 2
fi

blu "Resolving InstanceId and API domain from stack ${STACK_NAME} in ${REGION} ..."
IID=$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" \
  --output text 2>/dev/null || true)
APIDOM=$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiDomainName'].OutputValue | [0]" \
  --output text 2>/dev/null || true)
if [ -z "$IID" ] || [ "$IID" = "None" ]; then
  red "Could not resolve InstanceId from stack outputs."
  exit 3
fi

echo "InstanceId: $IID"
echo "ApiDomain: ${APIDOM:-<unknown>}"

TMP=$(mktemp)
if $REPAIR; then
  cat > "$TMP" <<JSON
{
  "commands": [
    "set -e",
    "cd /opt/ticktock || cd /",
    "echo '=== ensure Caddyfile and start caddy ==='",
    "if [ -d /opt/ticktock/Caddyfile ]; then rm -rf /opt/ticktock/Caddyfile; fi",
    "echo '${APIDOM} {' > /opt/ticktock/Caddyfile",
    "echo '  encode gzip' >> /opt/ticktock/Caddyfile",
    "echo '  reverse_proxy backend:8080' >> /opt/ticktock/Caddyfile",
    "echo '}' >> /opt/ticktock/Caddyfile",
    "NET=\$(docker network ls --format '{{.Name}}' | grep -E '^ticktock_default$' >/dev/null 2>&1 && echo ticktock_default || echo bridge)",
    "docker rm -f ticktock-caddy || true",
    "docker run -d --name ticktock-caddy --network \$NET -p 80:80 -p 443:443 -v /opt/ticktock/Caddyfile:/etc/caddy/Caddyfile --restart unless-stopped caddy:2 || true",
    "docker network connect \$NET ticktock-caddy 2>/dev/null || true",
    "echo '=== docker ps ==='",
    "docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true",
    "echo '=== listening sockets (80/443/8080/8443) ==='",
    "ss -ltnp | egrep ':(80|443|8080|8443)' || true",
    "echo '=== local caddy vhost health http://127.0.0.1/healthz (Host header) ==='",
    "curl -sk --max-time 8 -H 'Host: ${APIDOM}' http://127.0.0.1/healthz || true",
    "echo '=== last 80 lines caddy logs ==='",
    "docker logs --tail=80 ticktock-caddy 2>&1 || true"
  ]
}
JSON
else
  cat > "$TMP" <<'JSON'
{
  "commands": [
    "set -e",
    "cd /opt/ticktock || cd /",
    "echo '=== uname and uptime ==='",
    "uname -a; uptime || true",
    "echo '=== docker version ==='",
    "docker --version; docker compose version || true",
    "echo '=== docker ps ==='",
    "docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true",
    "echo '=== docker networks ==='",
    "docker network ls || true",
    "echo '=== backend container inspect (networks, ip) ==='",
    "docker inspect ticktock-backend --format '{{json .NetworkSettings.Networks}}' 2>/dev/null || true",
    "echo '=== listening sockets (80/443/8080/8443) ==='",
    "ss -ltnp | egrep ':(80|443|8080|8443)' || true",
    "echo '=== Caddyfile contents ==='",
    "if [ -d /opt/ticktock/Caddyfile ]; then echo '[WARN] Caddyfile is a directory'; ls -la /opt/ticktock/Caddyfile; else cat /opt/ticktock/Caddyfile 2>/dev/null || echo '[missing]'; fi",
    "echo '=== docker compose ps (if available) ==='",
    "if command -v docker-compose >/dev/null 2>&1; then docker-compose ps || true; else docker compose ps || true; fi",
    "echo '=== local backend health http://localhost:8080/healthz ==='",
    "curl -sS --max-time 6 http://localhost:8080/healthz || true",
    "echo '=== local caddy vhost health http://127.0.0.1/healthz (Host header) ==='",
    "H=${APIDOM:-api.local}; curl -sk --max-time 8 -H \"Host: $H\" http://127.0.0.1/healthz || true",
    "echo '=== last 120 lines caddy logs (if present) ==='",
    "docker logs --tail=120 ticktock-caddy 2>&1 || true",
    "echo '=== nginx.conf (if present) ==='",
    "cat /opt/ticktock/nginx/nginx.conf 2>/dev/null || true",
    "echo '=== last 120 lines nginx logs (if present) ==='",
    "docker logs --tail=120 ticktock-nginx 2>&1 || true",
    "echo '=== last 120 lines backend logs ==='",
    "docker logs --tail=120 ticktock-backend 2>&1 || true"
  ]
}
JSON
fi

blu "Sending SSM command ..."
CMD_ID=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "$IID" \
  --document-name "AWS-RunShellScript" \
  --parameters file://$TMP \
  --query "Command.CommandId" --output text)

# Wait briefly then fetch output
sleep 15
OUT=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$IID" --query "StandardOutputContent" --output text || true)
ERR=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$IID" --query "StandardErrorContent" --output text || true)

printf "\n===== SSM STDOUT =====\n%s\n" "$OUT"
if [ -n "$ERR" ] && [ "$ERR" != "None" ]; then
  printf "\n===== SSM STDERR =====\n%s\n" "$ERR"
fi

rm -f "$TMP" 2>/dev/null || true
