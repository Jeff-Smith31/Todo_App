#!/usr/bin/env bash
set -euo pipefail

# Wrapper to deploy backend using discovered IDs from infra/state/state.json
# Usage:
#   infra/scripts/deploy-backend-from-state.sh <STACK_NAME> [REGION] [API_SUBDOMAIN]

STACK_NAME=${1:?'STACK_NAME required'}
REGION=${2:-$(aws configure get region || echo us-east-1)}
API_SUBDOMAIN=${3:-api}
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$(cd "$ROOT_DIR/.." && pwd)/infra/state/state.json"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-backend.sh"

[ -f "$DEPLOY_SCRIPT" ] || { echo "Missing $DEPLOY_SCRIPT" >&2; exit 2; }

read_state() {
  local key=$1
  [ -f "$STATE_FILE" ] || { echo ""; return; }
  python3 - "$STATE_FILE" "$key" <<'PY'
import json, sys
p, k = sys.argv[1:]
try:
  with open(p) as f: d = json.load(f)
except Exception:
  d = {}
cur = d
for part in k.split('.'):
    if not isinstance(cur, dict) or part not in cur:
        print('')
        sys.exit(0)
    cur = cur[part]
print(cur if isinstance(cur, str) else '')
PY
}

DOMAIN=$(read_state DomainName)
HZ_ID=$(read_state HostedZoneId)
VPC_ID=$(read_state VpcId)
SUBNETS_CSV=$(read_state PublicSubnetIds)
SUBNET_ID=${SUBNETS_CSV%%,*}
ALLOWED_ORIGINS="https://${DOMAIN},https://www.${DOMAIN}"

if [ -z "$DOMAIN" ] || [ -z "$HZ_ID" ] || [ -z "$VPC_ID" ] || [ -z "$SUBNET_ID" ]; then
  echo "Missing required values in state. Ensure you ran discover-or-create-aws.sh." >&2
  exit 2
fi

CREATE_API_DNS_RECORD=${CREATE_API_DNS_RECORD:-true}
export CREATE_API_DNS_RECORD

"$DEPLOY_SCRIPT" "$STACK_NAME" "$DOMAIN" "$HZ_ID" "$VPC_ID" "$SUBNET_ID" "$ALLOWED_ORIGINS" "$API_SUBDOMAIN" "${REPO_URL:-https://github.com/example/Todo_App.git}" "$REGION"