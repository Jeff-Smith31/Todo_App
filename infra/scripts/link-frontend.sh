#!/usr/bin/env bash
set -euo pipefail

# Link the CloudFront+S3 frontend to the backend API by writing config.js and invalidating CloudFront.
# Usage:
#   infra/scripts/link-frontend.sh <FRONT_STACK_NAME> <BACK_STACK_NAME> [FRONT_REGION] [BACK_REGION]
# Env overrides:
#   BACKEND_OVERRIDE_URL  If set, use this URL for BACKEND_URL instead of stack output
#   USE_RELATIVE_API=true Use relative API (empty BACKEND_URL) when CloudFront routes /api/* to backend
#   EXTRA_INVALIDATE      Additional paths (space-separated) to include in invalidation

FRONT_STACK=${1:?'Frontend stack name required'}
BACK_STACK=${2:?'Backend stack name required'}
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

echo "Uploading config.js to s3://$BUCKET/config.js with BACKEND_URL=${CHOSEN_URL:-<relative>}"
echo -e "$CONFIG_CONTENT" | aws s3 cp - "s3://$BUCKET/config.js" --content-type application/javascript --cache-control "no-cache, no-store, must-revalidate" --region "$FRONT_REGION"

# Invalidate CloudFront for config and core shell so clients pick up new backend
INVALIDATE_PATHS=(
  "/config.js" "/index.html" "/app.js" "/styles.css" "/sw.js" "/manifest.json" "/manifest.webmanifest" "/app-version.js" "/version.json" "/icons/*"
)
if [[ -n "${EXTRA_INVALIDATE:-}" ]]; then
  for p in ${EXTRA_INVALIDATE}; do INVALIDATE_PATHS+=("$p"); done
fi

echo "Creating CloudFront invalidation..."
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "${INVALIDATE_PATHS[@]}" >/dev/null

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
