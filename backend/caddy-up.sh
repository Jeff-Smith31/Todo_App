#!/usr/bin/env bash
# Deprecated: Caddy is no longer used for TickTock Tasks backend.
# The project now uses Nginx + Certbot. To start the reverse proxy locally:
#   docker compose up -d nginx
# This script remains only to prevent confusion if referenced by old docs.
echo "[deprecated] Caddy is no longer used. Use: docker compose up -d nginx" >&2
exit 1
