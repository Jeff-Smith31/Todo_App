Param(
  [string]$SourcePath = "frontend/website",
  [string]$ZipPath = "frontend/website/app-download.zip"
)

# Resolve to full path
$src = Resolve-Path $SourcePath
$zip = Resolve-Path -LiteralPath (Split-Path $ZipPath -Parent) -ErrorAction SilentlyContinue
if (-not $zip) { New-Item -ItemType Directory -Force -Path (Split-Path $ZipPath -Parent) | Out-Null }

# Remove existing zip if exists
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }

# Create ZIP of the website contents
Compress-Archive -Path "$SourcePath/*" -DestinationPath $ZipPath -Force

Write-Host "Created: $ZipPath"