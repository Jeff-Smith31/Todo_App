#!/usr/bin/env bash
set -euo pipefail

# Discover or create AWS resources needed for deployment and persist their IDs.
# This script writes a JSON state file with HostedZoneId, VpcId, PublicSubnetIds, and ACM cert ARNs.
# It prefers existing resources and only creates when not found. It is idempotent and safe to re-run.
#
# Usage:
#   infra/scripts/discover-or-create-aws.sh <DOMAIN_NAME> [REGION]
#
# Notes:
# - Route53 is global. ACM for CloudFront must be in us-east-1. ACM for ALB/EC2 HTTPS would be in your app region.
# - We do NOT automatically create a Hosted Zone for an external registrar domain; pass an existing Hosted Zone.
# - If no public subnets exist, we create a minimal VPC with 2 public subnets and an Internet Gateway.
# - Outputs are written to infra/state/state.json.

DOMAIN=${1:?'DOMAIN_NAME required (e.g., example.com)'}
REGION=${2:-$(aws configure get region || echo us-east-1)}

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/infra/state"
STATE_FILE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"

jq_bin() {
  if command -v jq >/dev/null 2>&1; then echo jq; else echo python3 - <<'PY'
import sys, json
print(json.dumps(json.load(sys.stdin)))
PY
  fi
}
JQ=$(jq_bin)

write_state() {
  local key=$1 val=$2
  if [ -f "$STATE_FILE" ]; then
    tmp=$(mktemp)
    python3 - "$STATE_FILE" "$key" "$val" > "$tmp" <<'PY'
import json, sys
p, k, v = sys.argv[1:]
d = {}
try:
  with open(p) as f: d = json.load(f)
except Exception:
  d = {}
# support nested keys like Acm.CloudFrontArn
cur = d
parts = k.split('.')
for i, part in enumerate(parts):
    if i == len(parts) - 1:
        cur[part] = v
    else:
        if part not in cur or not isinstance(cur[part], dict):
            cur[part] = {}
        cur = cur[part]
json.dump(d, sys.stdout, indent=2)
PY
    mv "$tmp" "$STATE_FILE"
  else
    printf '{"%s":"%s"}\n' "$key" "$val" > "$STATE_FILE"
  fi
}

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

say() { echo "[discover] $*"; }

# 1) Hosted Zone
say "Looking for Hosted Zone for $DOMAIN"
HZ_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name "$DOMAIN" --query "HostedZones[?Name=='$DOMAIN.' && Config.PrivateZone==`false`].Id | [0]" \
  --output text | sed -e 's|/hostedzone/||')
if [ -z "$HZ_ID" ] || [ "$HZ_ID" = "None" ]; then
  say "No public hosted zone found for $DOMAIN. Creating one..."
  CREATE_OUT=$(aws route53 create-hosted-zone --name "$DOMAIN" --caller-reference "ttt-$(date +%s)" --query "HostedZone.Id" --output text)
  HZ_ID=$(echo "$CREATE_OUT" | sed -e 's|/hostedzone/||')
  say "Created Hosted Zone: $HZ_ID (you must set NS records at your registrar)"
else
  say "Using existing Hosted Zone: $HZ_ID"
fi
write_state HostedZoneId "$HZ_ID"
write_state DomainName "$DOMAIN"

# 2) VPC and public subnets
say "Discovering default VPC in $REGION"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  say "No default VPC found; creating minimal VPC"
  VPC_ID=$(aws ec2 create-vpc --region "$REGION" --cidr-block 10.0.0.0/16 --query Vpc.VpcId --output text)
  aws ec2 modify-vpc-attribute --region "$REGION" --vpc-id "$VPC_ID" --enable-dns-hostnames
  IGW_ID=$(aws ec2 create-internet-gateway --region "$REGION" --query InternetGateway.InternetGatewayId --output text)
  aws ec2 attach-internet-gateway --region "$REGION" --vpc-id "$VPC_ID" --internet-gateway-id "$IGW_ID"
  RT_ID=$(aws ec2 create-route-table --region "$REGION" --vpc-id "$VPC_ID" --query RouteTable.RouteTableId --output text)
  aws ec2 create-route --region "$REGION" --route-table-id "$RT_ID" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID" >/dev/null
  # Create two public subnets in different AZs
  AZS=($(aws ec2 describe-availability-zones --region "$REGION" --query 'AvailabilityZones[?State==`available`].ZoneName' --output text))
  SUBNET_IDS=()
  for i in 0 1; do
    CIDR="10.0.$((i*16)).0/20"
    SN_ID=$(aws ec2 create-subnet --region "$REGION" --vpc-id "$VPC_ID" --cidr-block "$CIDR" --availability-zone "${AZS[$i]}" --query Subnet.SubnetId --output text)
    aws ec2 modify-subnet-attribute --region "$REGION" --subnet-id "$SN_ID" --map-public-ip-on-launch
    aws ec2 associate-route-table --region "$REGION" --route-table-id "$RT_ID" --subnet-id "$SN_ID" >/dev/null
    SUBNET_IDS+=("$SN_ID")
  done
else
  say "Using VPC: $VPC_ID"
  # Get up to two public subnets (map-public-ip-on-launch=true)
  mapfile -t SUBNET_IDS < <(aws ec2 describe-subnets --region "$REGION" --filters Name=vpc-id,Values="$VPC_ID" Name=map-public-ip-on-launch,Values=true --query 'Subnets[].SubnetId' --output text | tr '\t' '\n' | head -n 2)
  if [ ${#SUBNET_IDS[@]} -lt 1 ]; then
    say "No public subnets found; creating one"
    AZ=$(aws ec2 describe-availability-zones --region "$REGION" --query 'AvailabilityZones[0].ZoneName' --output text)
    RT_ID=$(aws ec2 describe-route-tables --region "$REGION" --filters Name=vpc-id,Values="$VPC_ID" --query 'RouteTables[0].RouteTableId' --output text)
    if [ -z "$RT_ID" ] || [ "$RT_ID" = "None" ]; then
      RT_ID=$(aws ec2 create-route-table --region "$REGION" --vpc-id "$VPC_ID" --query RouteTable.RouteTableId --output text)
      IGW_ID=$(aws ec2 describe-internet-gateways --region "$REGION" --filters Name=attachment.vpc-id,Values="$VPC_ID" --query 'InternetGateways[0].InternetGatewayId' --output text)
      [ -n "$IGW_ID" ] && [ "$IGW_ID" != "None" ] || IGW_ID=$(aws ec2 create-internet-gateway --region "$REGION" --query InternetGateway.InternetGatewayId --output text)
      aws ec2 attach-internet-gateway --region "$REGION" --vpc-id "$VPC_ID" --internet-gateway-id "$IGW_ID" || true
      aws ec2 create-route --region "$REGION" --route-table-id "$RT_ID" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID" >/dev/null || true
    fi
    CIDR="10.0.100.0/24"
    SN_ID=$(aws ec2 create-subnet --region "$REGION" --vpc-id "$VPC_ID" --cidr-block "$CIDR" --availability-zone "$AZ" --query Subnet.SubnetId --output text)
    aws ec2 modify-subnet-attribute --region "$REGION" --subnet-id "$SN_ID" --map-public-ip-on-launch
    aws ec2 associate-route-table --region "$REGION" --route-table-id "$RT_ID" --subnet-id "$SN_ID" >/dev/null
    SUBNET_IDS=("$SN_ID")
  fi
fi

write_state VpcId "$VPC_ID"
# Join subnets into CSV
SUBNETS_CSV=$(printf "%s," "${SUBNET_IDS[@]}" | sed 's/,$//')
write_state PublicSubnetIds "$SUBNETS_CSV"

# 3) ACM certificate for CloudFront (us-east-1)
CF_REGION="us-east-1"
say "Ensuring ACM certificate in $CF_REGION for $DOMAIN (+ www)"
CF_CERT_ARN=$(aws acm list-certificates --region "$CF_REGION" --certificate-statuses ISSUED PENDING_VALIDATION INACTIVE \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)
if [ -z "$CF_CERT_ARN" ] || [ "$CF_CERT_ARN" = "None" ]; then
  say "Requesting new ACM cert in $CF_REGION"
  ALT_NAMES=("www.$DOMAIN")
  ARGS=(--domain-name "$DOMAIN" --validation-method DNS)
  for san in "${ALT_NAMES[@]}"; do ARGS+=(--subject-alternative-names "$san"); done
  CF_CERT_ARN=$(aws acm request-certificate --region "$CF_REGION" "${ARGS[@]}" --query CertificateArn --output text)
  # Set DNS validation records automatically in Route53
  CHANGES=$(aws acm describe-certificate --region "$CF_REGION" --certificate-arn "$CF_CERT_ARN" --query 'Certificate.DomainValidationOptions')
  # shellcheck disable=SC2016
  echo "$CHANGES" | python3 - "$HZ_ID" <<'PY'
import json, sys
hz_id = None
try:
  hz_id = open('infra/state/state.json').read()
except: pass
PY
  for row in $(aws acm describe-certificate --region "$CF_REGION" --certificate-arn "$CF_CERT_ARN" \
      --query 'Certificate.DomainValidationOptions[].ResourceRecord.Name' --output text); do
    VAL=$(aws acm describe-certificate --region "$CF_REGION" --certificate-arn "$CF_CERT_ARN" \
      --query "Certificate.DomainValidationOptions[?ResourceRecord.Name=='$row'].ResourceRecord.Value | [0]" --output text)
    aws route53 change-resource-record-sets --hosted-zone-id "$HZ_ID" --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$row\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$VAL\"}]}}]}" >/dev/null || true
  done
  say "Requested cert: $CF_CERT_ARN. It may take minutes to validate."
else
  say "Using existing cert: $CF_CERT_ARN"
fi
write_state Acm.CloudFrontArn "$CF_CERT_ARN"

# 4) Region hint
write_state Region "$REGION"

say "State written to $STATE_FILE"
cat "$STATE_FILE" || true
