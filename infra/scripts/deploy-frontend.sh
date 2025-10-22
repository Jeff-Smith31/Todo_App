#!/usr/bin/env bash
set -euo pipefail

# Deploy CloudFront + S3 frontend stack, preferring saved IDs from infra/state/state.json
# Usage:
#   infra/scripts/deploy-frontend.sh <STACK_NAME> [REGION]
# Env:
#   DOMAIN_NAME          Override domain name; else read from state
#   HOSTED_ZONE_ID       Override hosted zone id; else read from state
#   EXISTING_CERT_ARN    If provided, uses this cert; else read state Acm.CloudFrontArn if present
#   EXISTING_BUCKET_NAME If provided, reuse existing bucket
#   CREATE_DNS=true|false Default true
#   INCLUDE_WWW=true|false Default true
#   INCLUDE_APP=true|false Default true
#   APP_SUBDOMAIN=app
#   SKIP_ALIASES=false

STACK_NAME=${1:?'STACK_NAME required'}
REGION=${2:-$(aws configure get region || echo us-east-1)}
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TPL_FILE="$ROOT_DIR/frontend/template.yaml"
STATE_FILE="$(cd "$ROOT_DIR/.." && pwd)/infra/state/state.json"

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

DOMAIN="${DOMAIN_NAME:-$(read_state DomainName)}"
HZ_ID="${HOSTED_ZONE_ID:-$(read_state HostedZoneId)}"
CERT_ARN="${EXISTING_CERT_ARN:-$(read_state Acm.CloudFrontArn)}"
CREATE_DNS=${CREATE_DNS:-true}
INCLUDE_WWW=${INCLUDE_WWW:-true}
INCLUDE_APP=${INCLUDE_APP:-true}
APP_SUBDOMAIN=${APP_SUBDOMAIN:-app}
SKIP_ALIASES=${SKIP_ALIASES:-false}

if [ -z "$DOMAIN" ] || [ -z "$HZ_ID" ]; then
  echo "Domain and HostedZoneId are required. Either run discover-or-create-aws.sh or pass env overrides." >&2
  exit 2
fi

set -x
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TPL_FILE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    DomainName="$DOMAIN" \
    HostedZoneId="$HZ_ID" \
    ExistingCertificateArn="${CERT_ARN}" \
    ExistingBucketName="${EXISTING_BUCKET_NAME:-}" \
    CreateDnsRecords="${CREATE_DNS}" \
    IncludeWww="${INCLUDE_WWW}" \
    IncludeAppSubdomain="${INCLUDE_APP}" \
    AppSubdomain="${APP_SUBDOMAIN}" \
    SkipAliases="${SKIP_ALIASES}"
set +x

# Capture outputs
OUT=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" --query 'Stacks[0].Outputs' --output json)
BUCKET=$(echo "$OUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(next((o['OutputValue'] for o in d if o['OutputKey']=='BucketName'), ''))")
DIST_ID=$(echo "$OUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(next((o['OutputValue'] for o in d if o['OutputKey']=='DistributionId'), ''))")
CF_DOMAIN=$(echo "$OUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(next((o['OutputValue'] for o in d if o['OutputKey']=='DistributionDomainName'), ''))")

# Save to state for convenience
STATE_DIR="$(cd "$ROOT_DIR/.." && pwd)/infra/state"
mkdir -p "$STATE_DIR"
python3 - "$STATE_DIR/state.json" "$BUCKET" "$DIST_ID" "$CF_DOMAIN" <<'PY'
import json, sys, os
p, b, d, dom = sys.argv[1:]
try:
    data = json.load(open(p))
except Exception:
    data = {}
ui = data.setdefault('Frontend', {})
ui['BucketName'] = b
ui['DistributionId'] = d
ui['CloudFrontDomainName'] = dom
json.dump(data, open(p,'w'), indent=2)
print(json.dumps(data, indent=2))
PY

echo "Frontend stack deployed. Bucket=$BUCKET Distribution=$DIST_ID Domain=$CF_DOMAIN"
