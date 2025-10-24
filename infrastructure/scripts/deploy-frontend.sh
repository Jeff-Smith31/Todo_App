#!/usr/bin/env bash
set -euo pipefail

# Deploy the S3 + CloudFront frontend and upload site content
#
# Usage:
#   infrastructure/scripts/deploy-frontend.sh <STACK_NAME> <DOMAIN_NAME> [HOSTED_ZONE_ID] [AWS_REGION]
#
# Notes:
# - Runs in us-east-1 by default (required for CloudFront certs)
# - If HOSTED_ZONE_ID is omitted, defaults to the TickTock Tasks zone ID.
# - After stack exists, syncs ./frontend/website to the bucket
# - Writes config.js with BACKEND_URL=https://api.<DomainName>
# - Invalidates CloudFront

STACK_NAME=${1:?'STACK_NAME required'}
DOMAIN=${2:?'DOMAIN_NAME required'}
HZ_ID=${3:-Z08471201NA2PN7ERBIB7}
REGION=${4:-us-east-1}

TPL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TPL_FILE="$TPL_DIR/frontend/template.yaml"
SITE_DIR="$(cd "$TPL_DIR/.." && pwd)/frontend/website"

if [ ! -f "$TPL_FILE" ]; then
  echo "Template not found: $TPL_FILE" >&2
  exit 2
fi

if [ ! -d "$SITE_DIR" ]; then
  echo "Frontend website directory not found: $SITE_DIR" >&2
  exit 2
fi

# Detect existing bucket to reuse
EXISTING_BUCKET=""
CANDIDATE_BUCKET="${DOMAIN}-site"
if aws s3api head-bucket --bucket "$CANDIDATE_BUCKET" 2>/dev/null; then
  EXISTING_BUCKET="$CANDIDATE_BUCKET"
  echo "Found existing bucket: $EXISTING_BUCKET — will reuse"
else
  echo "No existing bucket named $CANDIDATE_BUCKET — stack may create a new one"
fi

echo "Deploying frontend stack: $STACK_NAME in $REGION for $DOMAIN using HostedZoneId=$HZ_ID"
set -x
if [ -n "$EXISTING_BUCKET" ]; then
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --template-file "$TPL_FILE" \
    --no-fail-on-empty-changeset \
    --parameter-overrides DomainName="$DOMAIN" HostedZoneId="$HZ_ID" ExistingBucketName="$EXISTING_BUCKET"
else
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --template-file "$TPL_FILE" \
    --no-fail-on-empty-changeset \
    --parameter-overrides DomainName="$DOMAIN" HostedZoneId="$HZ_ID"
fi
set +x

# Fetch outputs
BUCKET=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
DISTRIBUTION_ID=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

if [ -z "$BUCKET" ] || [ -z "$DISTRIBUTION_ID" ]; then
  echo "Failed to obtain outputs (Bucket, DistributionId)." >&2
  exit 3
fi

echo "Writing runtime config for backend URL..."
cat > "$SITE_DIR/config.js" <<EOF
window.RUNTIME_CONFIG = {
  BACKEND_URL: 'https://api.${DOMAIN}'
};
EOF

echo "Syncing site to s3://$BUCKET ..."
aws s3 sync "$SITE_DIR" "s3://$BUCKET" --delete

# Ensure config.js is not cached by browsers/CloudFront so BACKEND_URL updates take effect immediately
if [ -f "$SITE_DIR/config.js" ]; then
  echo "Uploading config.js with no-store Cache-Control headers..."
  aws s3 cp "$SITE_DIR/config.js" "s3://$BUCKET/config.js" \
    --cache-control "no-store, no-cache, must-revalidate, max-age=0" \
    --content-type "application/javascript; charset=utf-8"
fi

echo "Creating CloudFront invalidation for config.js and assets..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/config.js" "/*" >/dev/null

echo "Frontend deployed: https://$DOMAIN (CloudFront)"
