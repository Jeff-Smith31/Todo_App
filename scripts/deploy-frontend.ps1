param(
  [Parameter(Mandatory=$true)][string]$BucketName,
  [Parameter(Mandatory=$true)][string]$DistributionId,
  [string]$Path = "frontend\website"
)

# Deploy TickTock Tasks frontend to S3 and invalidate CloudFront
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\deploy-frontend.ps1 -BucketName your-bucket -DistributionId E1234567890AB [-Path frontend\website]
# Requires: AWS Tools or AWS CLI in PATH. This script uses aws CLI for portability.

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  Write-Error "aws CLI not found. Please install and configure AWS CLI."
  exit 2
}

Write-Host "Syncing $Path to s3://$BucketName ..."
aws s3 sync "$Path" "s3://$BucketName" --delete --cache-control "max-age=31536000,public" --exclude "config.js"

# Upload config.js with short cache
$configPath = Join-Path $Path "config.js"
if (Test-Path $configPath) {
  Write-Host "Uploading runtime config.js with short cache..."
  aws s3 cp "$configPath" "s3://$BucketName/config.js" --cache-control "max-age=60,no-cache"
}

Write-Host "Creating CloudFront invalidation..."
$invId = aws cloudfront create-invalidation --distribution-id "$DistributionId" --paths "/*" --query 'Invalidation.Id' --output text
Write-Host "Created CloudFront invalidation: $invId"
Write-Host "Deployment complete."