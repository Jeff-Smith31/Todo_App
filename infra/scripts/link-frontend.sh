#!/usr/bin/env bash
set -euo pipefail

# DEPRECATED: This project no longer deploys the frontend to S3/CloudFront.
# The frontend is served by Nginx on the same EC2 instance as the backend.
# This script is kept for historical reference but is disabled to prevent misuse.
# To configure the frontend, edit frontend/website/config.js (BACKEND_URL) or use same-origin via Nginx.

echo "[DEPRECATED] infra/scripts/link-frontend.sh is disabled. Frontend is no longer deployed to S3/CloudFront. Exiting successfully (no-op)." >&2
exit 0

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
STACK_BACKEND_URL=$(get_output "$BACK_STACK" BackendEndpoint "$BACK_REGION")

if [[ -z "$BUCKET" || "$BUCKET" == "None" || -z "$DIST_ID" || "$DIST_ID" == "None" ]]; then
  echo "Failed to resolve frontend outputs. Got:"
  echo "  BucketName=$BUCKET"
  echo "  DistributionId=$DIST_ID"
  exit 1
fi

CHOSEN_URL="$STACK_BACKEND_URL"
if [[ "${USE_RELATIVE_API:-}" == "true" ]]; then
  CHOSEN_URL=""
elif [[ -n "${BACKEND_OVERRIDE_URL:-}" ]]; then
  CHOSEN_URL="$BACKEND_OVERRIDE_URL"
fi

# Health probe (best-effort)
REACHABLE="unknown"
if [[ -n "$CHOSEN_URL" ]]; then
  if curl -sk --max-time 8 "$CHOSEN_URL/healthz" >/dev/null 2>&1; then
    REACHABLE="ok"
  else
    REACHABLE="fail"
  fi
fi

CONFIG_CONTENT="window.RUNTIME_CONFIG = Object.assign({}, window.RUNTIME_CONFIG || {}, { BACKEND_URL: '${CHOSEN_URL}' });\n"

echo "Uploading config.js to s3://$BUCKET/config.js with BACKEND_URL=$CHOSEN_URL"
echo -e "$CONFIG_CONTENT" | aws s3 cp - "s3://$BUCKET/config.js" --content-type application/javascript --cache-control "no-cache, no-store, must-revalidate" --region "$FRONT_REGION"

echo "Creating CloudFront invalidation for /config.js"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/config.js" >/dev/null

# Append a note to GitHub Actions job summary if available
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "Linked frontend to backend endpoint:";
    echo "- S3 Bucket: s3://$BUCKET";
    echo "- CloudFront Distribution: $DIST_ID";
    echo "- Backend URL (chosen): ${CHOSEN_URL:-<relative>}";
    echo "- Health probe: $REACHABLE";
    if [ -n "${STACK_BACKEND_URL:-}" ] && [ "${STACK_BACKEND_URL}" != "None" ]; then
      echo "- Backend URL (stack output): ${STACK_BACKEND_URL}";
    fi
    if [ -n "${BACKEND_OVERRIDE_URL:-}" ]; then
      echo "- Override provided: ${BACKEND_OVERRIDE_URL}";
    fi
    if [ "${USE_RELATIVE_API:-}" = "true" ]; then
      echo "- Using relative API (BACKEND_URL empty)";
    fi
  } >> "$GITHUB_STEP_SUMMARY" || true
fi

echo "Done. Frontend should now use ${CHOSEN_URL:-relative API} automatically on next refresh."
