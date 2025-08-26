#!/usr/bin/env bash
set -euo pipefail
# Start Caddy reverse proxy profile from anywhere
# Usage: bash backend/caddy-up.sh
cd "$(dirname "$0")"
if docker compose version >/dev/null 2>&1; then
  docker compose --profile proxy up -d caddy
else
  docker-compose --profile proxy up -d caddy
fi
