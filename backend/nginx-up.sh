#!/usr/bin/env bash
set -euo pipefail
# Start Nginx reverse proxy profile from anywhere
# Usage: bash backend/nginx-up.sh
cd "$(dirname "$0")"
if docker compose version >/dev/null 2>&1; then
  docker compose --profile nginx up -d nginx
else
  docker-compose --profile nginx up -d nginx
fi
