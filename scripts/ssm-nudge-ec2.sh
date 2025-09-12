#!/usr/bin/env bash
# Send an SSM command to the backend EC2 host to run the robust nudge script on-host.
# Usage: scripts/ssm-nudge-ec2.sh [STACK_NAME] [REGION]
# Defaults: STACK_NAME=${BACKEND_STACK_NAME:-ttt-backend}, REGION=${BACKEND_REGION or aws configured or us-east-1}
set -euo pipefail

STACK_NAME="${1:-${BACKEND_STACK_NAME:-ttt-backend}}"
REGION="${2:-${BACKEND_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }

grN() { printf "\033[32m%s\033[0m\n" "$*"; }

if ! command -v aws >/dev/null 2>&1; then
  red "AWS CLI v2 is required. Install and configure credentials."
  exit 2
fi

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
  red "Could not resolve InstanceId from stack ${STACK_NAME} in ${REGION}."
  exit 3
fi

if [ -z "$APIDOM" ] || [ "$APIDOM" = "None" ]; then
  # Fallback to default used by this project
  APIDOM="api.ticktocktasks.com"
fi
SUB=${APIDOM%%.*}
DOM=${APIDOM#${SUB}.}

PARAMS_FILE=$(mktemp)
cat > "$PARAMS_FILE" <<JSON
{
  "commands": [
    "set -e",
    "cd /opt/ticktock || cd /",
    "echo --- export APIDOM/DOMAIN ---",
    "export APIDOM=${APIDOM}",
    "export API_SUBDOMAIN=${SUB}",
    "export DOMAIN_NAME=${DOM}",
    "echo --- pull repo ---",
    "if [ -d /opt/ticktock/.git ]; then cd /opt/ticktock && git pull --rebase || true; fi",
    "echo --- run nudge ---",
    "bash /opt/ticktock/scripts/ssm-nudge.sh",
    "echo --- docker ps ---",
    "docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true",
    "echo --- localhost health (nginx and backend) ---",
    "curl -sk --max-time 8 -H 'Host: ${APIDOM}' http://127.0.0.1/healthz || true",
    "curl -sS --max-time 6 http://localhost:8080/healthz || true",
    "echo --- tail nginx/backend logs ---",
    "docker logs --tail=140 ticktock-nginx 2>&1 || true",
    "docker logs --tail=140 ticktock-backend 2>&1 || true"
  ]
}
JSON

CMD_ID=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "$IID" \
  --document-name "AWS-RunShellScript" \
  --parameters file://$PARAMS_FILE \
  --query "Command.CommandId" --output text)

sleep 20
OUT=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$IID" --query "StandardOutputContent" --output text || true)
ERR=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$IID" --query "StandardErrorContent" --output text || true)

printf "\n===== SSM STDOUT =====\n%s\n" "$OUT"
if [ -n "$ERR" ] && [ "$ERR" != "None" ]; then
  printf "\n===== SSM STDERR =====\n%s\n" "$ERR"
fi

rm -f "$PARAMS_FILE" 2>/dev/null || true
