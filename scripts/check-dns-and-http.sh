#!/usr/bin/env bash
# Check DNS A/AAAA records and HTTP reachability for a domain and/or IP
# Usage:
#   ./scripts/check-dns-and-http.sh example.com [EC2_PUBLIC_IP]
# Notes:
# - Requires: dig or getent (optional), curl
# - This script does not change any infrastructure; it only reports diagnostics and guidance.

set -euo pipefail

DOMAIN="${1:-}"
EC2_IP="${2:-}"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <DOMAIN> [EC2_PUBLIC_IP]"
  exit 2
fi

PASS=0
FAIL=0

function header(){ echo; echo "== $1 =="; }
function ok(){ echo "[OK] $1"; PASS=$((PASS+1)); }
function warn(){ echo "[WARN] $1"; }
function err(){ echo "[ERR] $1"; FAIL=$((FAIL+1)); }

header "DNS lookup for $DOMAIN"
HAVE_DIG=1
if ! command -v dig >/dev/null 2>&1; then HAVE_DIG=0; fi

A_RECORDS=""
AAAA_RECORDS=""
if [[ $HAVE_DIG -eq 1 ]]; then
  A_RECORDS=$(dig +short A "$DOMAIN" | tr '\n' ' ' | sed 's/ *$//') || true
  AAAA_RECORDS=$(dig +short AAAA "$DOMAIN" | tr '\n' ' ' | sed 's/ *$//') || true
else
  if getent ahostsv4 "$DOMAIN" >/dev/null 2>&1; then
    A_RECORDS=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ *$//')
  fi
  if getent ahostsv6 "$DOMAIN" >/dev/null 2>&1; then
    AAAA_RECORDS=$(getent ahostsv6 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ *$//')
  fi
fi

if [[ -n "$A_RECORDS" ]]; then ok "A records: $A_RECORDS"; else err "No A records found."; fi
if [[ -n "$AAAA_RECORDS" ]]; then ok "AAAA records: $AAAA_RECORDS"; else warn "No AAAA records found (IPv6 optional)."; fi

if [[ -n "$EC2_IP" ]]; then
  header "DNS matches EC2 IP"
  if echo " $A_RECORDS " | grep -q " $EC2_IP "; then
    ok "A record contains EC2 IP $EC2_IP"
  else
    err "A record does not include EC2 IP $EC2_IP"
    warn "Update your DNS provider (Route53) A record to point $DOMAIN to $EC2_IP."
  fi
fi

header "HTTP reachability"
set +e
curl -sS -o /dev/null -w "%{http_code} %{remote_ip} %{remote_port}\n" "http://$DOMAIN" > /tmp/ttt_http.txt 2>/tmp/ttt_http.err
RC=$?
set -e
if [[ $RC -eq 0 ]]; then
  read -r CODE RIP RPORT < /tmp/ttt_http.txt || true
  if [[ "$CODE" =~ ^(200|204|30[12]|40[1347]|50[0-9])$ ]]; then
    ok "HTTP responded with $CODE from $RIP:$RPORT"
  else
    err "Unexpected HTTP status: $CODE"
  fi
else
  err "HTTP request failed: $(tr -d '\r' < /tmp/ttt_http.err)"
fi

header "HTTPS reachability and certificate"
set +e
curl -sS -o /dev/null -w "%{http_code} %{ssl_verify_result} %{remote_ip} %{remote_port}\n" "https://$DOMAIN" > /tmp/ttt_https.txt 2>/tmp/ttt_https.err
RC=$?
set -e
if [[ $RC -eq 0 ]]; then
  read -r HCODE SSLVER HRIP HRPORT < /tmp/ttt_https.txt || true
  if [[ "$HCODE" =~ ^(200|204|30[12]|40[1347]|50[0-9])$ ]]; then
    if [[ "$SSLVER" = "0" ]]; then
      ok "HTTPS responded with $HCODE (cert OK) from $HRIP:$HRPORT"
    else
      err "HTTPS responded with $HCODE but certificate verify result=$SSLVER (not 0)"
    fi
  else
    err "Unexpected HTTPS status: $HCODE"
  fi
else
  err "HTTPS request failed: $(tr -d '\r' < /tmp/ttt_https.err)"
fi

header "Nginx container health endpoint"
set +e
curl -sS -o /dev/null -w "%{http_code}\n" "http://$DOMAIN/nginx-healthz" > /tmp/ttt_hz.txt 2>/tmp/ttt_hz.err
RC=$?
set -e
if [[ $RC -eq 0 ]]; then
  HZ=$(cat /tmp/ttt_hz.txt)
  if [[ "$HZ" == "200" ]]; then
    ok "/nginx-healthz returned 200 (Nginx reachable)"
  else
    err "/nginx-healthz returned HTTP $HZ"
  fi
else
  err "/nginx-healthz request failed: $(tr -d '\r' < /tmp/ttt_hz.err)"
fi

header "Summary"
echo "Pass: $PASS  Fail: $FAIL"
if [[ $FAIL -gt 0 ]]; then
  echo
  echo "Guidance:"
  echo "- Ensure EC2 security group allows inbound TCP 80 from 0.0.0.0/0 (and ::/0)."
  echo "- Create/verify A record for $DOMAIN pointing to your EC2 public or Elastic IP."
  echo "- On EC2: docker compose ps; docker compose logs nginx; ensure port 80 is bound."
  echo "- Verify nginx.conf listens on 80 and serves the SPA root (already in this repo)."
  exit 1
else
  echo "All checks passed. DNS and HTTP routing appear functional."
fi
