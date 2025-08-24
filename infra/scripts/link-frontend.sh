#!/usr/bin/env bash
set -euo pipefail

# Link frontend to backend by writing config.js into the S3 site bucket
# Requirements:
# - AWS CLI v2 configured
# - Frontend stack deployed from infra/frontend/template.yaml
# - Backend stack deployed from infra/backend/template.yaml
#
# Usage:
#   ./infra/scripts/link-frontend.sh <FRONTEND_STACK_NAME> <BACKEND_STACK_NAME> [AWS_REGION]
#
# Example:
#   ./infra/scripts/link-frontend.sh ttt-frontend ttt-backend us-east-1

FRONT_STACK=${1:?"Frontend stack name required"}
BACK_STACK=${2:?"Backend stack name required"}
REGION=${3:-$(aws configure get region || echo us-east-1)}

get_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
}

BUCKET=$(get_output "$FRONT_STACK" BucketName)
DIST_ID=$(get_output "$FRONT_STACK" DistributionId)
BACKEND_URL=$(get_output "$BACK_STACK" BackendEndpoint)

if [[ -z "$BUCKET" || -z "$DIST_ID" || -z "$BACKEND_URL" ]]; then
  echo "Failed to resolve outputs. Got:"
  echo "  BucketName=$BUCKET"
  echo "  DistributionId=$DIST_ID"
  echo "  BackendEndpoint=$BACKEND_URL"
  exit 1
fi

CONFIG_CONTENT="window.RUNTIME_CONFIG = Object.assign({}, window.RUNTIME_CONFIG || {}, { BACKEND_URL: '${BACKEND_URL}' });\n"

echo "Uploading config.js to s3://$BUCKET/config.js with BACKEND_URL=$BACKEND_URL"
echo -e "$CONFIG_CONTENT" | aws s3 cp - "s3://$BUCKET/config.js" --content-type application/javascript --region "$REGION"

echo "Creating CloudFront invalidation for /config.js"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/config.js" >/dev/null

echo "Done. Frontend should now use $BACKEND_URL automatically on next refresh."
