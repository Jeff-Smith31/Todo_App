#!/usr/bin/env bash
set -euo pipefail

# Deploy the free-tier EC2 backend CloudFormation stack
#
# Usage:
#   ./infra/scripts/deploy-backend.sh \
#     <STACK_NAME> <DOMAIN_NAME> <HOSTED_ZONE_ID> <VPC_ID> <SUBNET_ID> \
#     [ALLOWED_ORIGINS] [API_SUBDOMAIN] [REPO_URL] [AWS_REGION]
#
# Example:
#   ./infra/scripts/deploy-backend.sh \
#     ttt-backend example.com Z123456ABCDEFG vpc-0123456789abcdef0 subnet-0123abcd \
#     "https://example.com,https://www.example.com" \
#     api https://github.com/jeff/Todo_App.git us-east-1
#
# Note: Frontend is not deployed via CloudFront anymore. Serve it via Nginx on the backend EC2.

STACK_NAME=${1:?'STACK_NAME required'}
DOMAIN=${2:?'DOMAIN_NAME required'}
HZ_ID=${3:?'HOSTED_ZONE_ID required'}
VPC_ID=${4:?'VPC_ID required'}
SUBNET_ID=${5:?'SUBNET_ID required'}
ALLOWED_ORIGINS=${6:-"https://${DOMAIN},https://www.${DOMAIN}"}
API_SUBDOMAIN=${7:-api}
REPO_URL=${8:-"https://github.com/example/Todo_App.git"}
REGION=${9:-$(aws configure get region || echo us-east-1)}

TPL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TPL_FILE="$TPL_DIR/backend/template.yaml"

if [ ! -f "$TPL_FILE" ]; then
  echo "Template not found: $TPL_FILE" >&2
  exit 2
fi

echo "Deploying backend stack: $STACK_NAME in $REGION"
set -x
# Allow caller to control DNS creation (default true)
CREATE_API_DNS_RECORD_VAL="${CREATE_API_DNS_RECORD:-true}"

# Attempt deploy with better ergonomics. Do not fail on empty changesets.
set +e
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TPL_FILE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    DomainName="$DOMAIN" \
    HostedZoneId="$HZ_ID" \
    VpcId="$VPC_ID" \
    SubnetId="$SUBNET_ID" \
    AllowedOrigins="$ALLOWED_ORIGINS" \
    ApiSubdomain="$API_SUBDOMAIN" \
    RepoUrl="$REPO_URL" \
    CreateApiDnsRecord="$CREATE_API_DNS_RECORD_VAL"
RC=$?
set -e
set +x

if [ $RC -ne 0 ]; then
  echo "Backend stack deploy failed (rc=$RC). Fetching recent stack events..." >&2
  # Print top-level stack status
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].{Status:StackStatus,Reason:StackStatusReason}" \
    --output table 2>&1 >&2 || true
  # Print last ~30 events for the stack
  aws cloudformation describe-stack-events \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "reverse(StackEvents)[0:30].[Timestamp,ResourceStatus,ResourceType,LogicalResourceId,ResourceStatusReason]" \
    --output table 2>&1 >&2 || true
  # Retry once after brief backoff in case of throttling/transient network issues
  echo "Retrying deploy once after 10s..." >&2
  sleep 10
  set +e
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --template-file "$TPL_FILE" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
      DomainName="$DOMAIN" \
      HostedZoneId="$HZ_ID" \
      VpcId="$VPC_ID" \
      SubnetId="$SUBNET_ID" \
      AllowedOrigins="$ALLOWED_ORIGINS" \
      ApiSubdomain="$API_SUBDOMAIN" \
      RepoUrl="$REPO_URL" \
      CreateApiDnsRecord="$CREATE_API_DNS_RECORD_VAL"
  RC2=$?
  set -e
  if [ $RC2 -ne 0 ]; then
    echo "Deploy retry also failed (rc=$RC2). See events above." >&2
    exit $RC2
  fi
fi

echo "Fetching outputs..."
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" \
  --output table

echo
echo
echo "Note: Frontend is not deployed via CloudFront/S3. It is served by Nginx on the backend EC2 host."
echo "Deploy/update frontend by pulling this repo on the EC2 instance and running: docker compose up -d --build"
echo