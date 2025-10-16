#!/usr/bin/env bash
set -euo pipefail

# Deploy TickTock Tasks frontend to S3 and invalidate CloudFront
# Usage:
#   ./scripts/deploy-frontend.sh <S3_BUCKET_NAME> <CLOUDFRONT_DISTRIBUTION_ID> [--path frontend/website]
# Example:
#   ./scripts/deploy-frontend.sh ticktocktasks.com-site E1234567890AB --path frontend/website
# Requires: aws CLI configured with permissions to S3 and CloudFront.

if [ $# -lt 2 ]; then
  echo "Usage: $0 <S3_BUCKET_NAME> <CLOUDFRONT_DISTRIBUTION_ID> [--path <dir>]"
  exit 1
fi

BUCKET="$1"
DIST_ID="$2"
DIR="frontend/website"
if [ "${3:-}" = "--path" ] && [ -n "${4:-}" ]; then
  DIR="$4"
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found. Please install and configure AWS CLI."
  exit 2
fi

# Sync site
echo "Syncing $DIR to s3://$BUCKET ..."
aws s3 sync "$DIR" "s3://$BUCKET" --delete --cache-control max-age=31536000,public --exclude "config.js"
# Upload config.js without long cache to ensure clients pick it up quickly
if [ -f "$DIR/config.js" ]; then
  echo "Uploading runtime config.js with short cache..."
  aws s3 cp "$DIR/config.js" "s3://$BUCKET/config.js" --cache-control max-age=60,no-cache
fi

# Create invalidation for all paths (safe for SPA + hashed assets)
INVALIDATION_ID=$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query 'Invalidation.Id' --output text)

echo "Created CloudFront invalidation: $INVALIDATION_ID"
echo "Deployment complete."