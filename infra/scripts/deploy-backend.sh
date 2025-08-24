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
#     "https://example.com,https://www.example.com,https://d111111abcdef8.cloudfront.net" \
#     api https://github.com/jeff/Todo_App.git us-east-1
#
# After stack creation, run link-frontend to wire the frontend automatically:
#   ./infra/scripts/link-frontend.sh <FRONTEND_STACK_NAME> <BACKEND_STACK_NAME> [AWS_REGION]

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
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TPL_FILE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DomainName="$DOMAIN" \
    HostedZoneId="$HZ_ID" \
    VpcId="$VPC_ID" \
    SubnetId="$SUBNET_ID" \
    AllowedOrigins="$ALLOWED_ORIGINS" \
    ApiSubdomain="$API_SUBDOMAIN" \
    RepoUrl="$REPO_URL" \
    CreateApiDnsRecord="$CREATE_API_DNS_RECORD_VAL"
set +x

echo "Fetching outputs..."
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" \
  --output table

echo
echo "Next: Link the frontend to this backend endpoint:"
echo "  ./infra/scripts/link-frontend.sh <FRONTEND_STACK_NAME> $STACK_NAME $REGION"
echo