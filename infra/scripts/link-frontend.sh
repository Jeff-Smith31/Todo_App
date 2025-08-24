#!/usr/bin/env bash
set -euo pipefail

# Link frontend to backend by writing config.js into the S3 site bucket
# Requirements:
# - AWS CLI v2 configured
# - Frontend stack deployed from infra/frontend/template.yaml
# - Backend stack deployed from infra/backend/template.yaml
#
# Usage:
#   ./infra/scripts/link-frontend.sh <FRONTEND_STACK_NAME> <BACKEND_STACK_NAME> [FRONTEND_REGION] [BACKEND_REGION]
#
# Examples:
#   ./infra/scripts/link-frontend.sh ttt-frontend ttt-backend us-east-1 us-east-1
#   ./infra/scripts/link-frontend.sh ttt-frontend ttt-backend us-east-1 (uses same region for both)

FRONT_STACK=${1:?"Frontend stack name required"}
BACK_STACK=${2:?"Backend stack name required"}
FRONT_REGION=${3:-$(aws configure get region || echo us-east-1)}
BACK_REGION=${4:-$FRONT_REGION}

get_output() {
  local stack="$1" key="$2" region="$3"
  aws cloudformation describe-stacks \
    --region "$region" \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
}

BUCKET=$(get_output "$FRONT_STACK" BucketName "$FRONT_REGION")
DIST_ID=$(get_output "$FRONT_STACK" DistributionId "$FRONT_REGION")
BACKEND_URL=$(get_output "$BACK_STACK" BackendEndpoint "$BACK_REGION")

if [[ -z "$BUCKET" || "$BUCKET" == "None" || -z "$DIST_ID" || "$DIST_ID" == "None" || -z "$BACKEND_URL" || "$BACKEND_URL" == "None" ]]; then
  echo "Failed to resolve outputs. Got:"
  echo "  BucketName=$BUCKET"
  echo "  DistributionId=$DIST_ID"
  echo "  BackendEndpoint=$BACKEND_URL"
  exit 1
fi

CONFIG_CONTENT="window.RUNTIME_CONFIG = Object.assign({}, window.RUNTIME_CONFIG || {}, { BACKEND_URL: '${BACKEND_URL}' });\n"

echo "Uploading config.js to s3://$BUCKET/config.js with BACKEND_URL=$BACKEND_URL"
echo -e "$CONFIG_CONTENT" | aws s3 cp - "s3://$BUCKET/config.js" --content-type application/javascript --region "$FRONT_REGION"

echo "Creating CloudFront invalidation for /config.js"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/config.js" >/dev/null

# Append a note to GitHub Actions job summary if available
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "Linked frontend to backend endpoint:";
    echo "- S3 Bucket: s3://$BUCKET";
    echo "- CloudFront Distribution: $DIST_ID";
    echo "- Backend URL: $BACKEND_URL";
  } >> "$GITHUB_STEP_SUMMARY" || true
fi

echo "Done. Frontend should now use $BACKEND_URL automatically on next refresh."
