#!/usr/bin/env bash
# Route53 helper to switch a domain's A record(s) from CloudFront to EC2 Nginx
# Usage:
#   ./scripts/route53-switch-to-ec2.sh -z <HOSTED_ZONE_ID> -d <DOMAIN> -i <EC2_PUBLIC_IP> [--include-www] [--apply]
# Notes:
# - Without --apply, the script prints the planned aws route53 CLI changes and exits without modifying DNS.
# - Requires: aws CLI and jq.

set -euo pipefail

HZ=""
DOMAIN=""
IP=""
INCLUDE_WWW=false
APPLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -z|--zone) HZ="$2"; shift; shift;;
    -d|--domain) DOMAIN="$2"; shift; shift;;
    -i|--ip) IP="$2"; shift; shift;;
    --include-www) INCLUDE_WWW=true; shift;;
    --apply) APPLY=true; shift;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //'; exit 0;;
    *) echo "Unknown argument: $1" >&2; exit 2;;
  esac
done

if [[ -z "$HZ" || -z "$DOMAIN" ]]; then
  echo "Usage: $0 -z <HOSTED_ZONE_ID> -d <DOMAIN> -i <EC2_PUBLIC_IP> [--include-www] [--apply]" >&2
  exit 2
fi
if [[ -z "$IP" ]]; then
  echo "Warning: No EC2 IP provided. The script will only show current DNS state and planned change." >&2
fi

# Ensure jq exists
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Please install jq and retry." >&2
  exit 2
fi

summ() { echo -e "$1"; }
ok() { echo "[OK] $1"; }
warn() { echo "[WARN] $1"; }
err() { echo "[ERR] $1"; }

summ "Checking Route53 records for ${DOMAIN} in zone ${HZ}"
JSON=$(aws route53 list-resource-record-sets --hosted-zone-id "$HZ")

# Helper to describe a name
describe_name() {
  local name="$1"
  local recs=$(echo "$JSON" | jq -r --arg N "${name}." '.ResourceRecordSets[] | select(.Name==$N and (.Type=="A" or .Type=="AAAA" or .Type=="CNAME"))')
  if [[ -z "$recs" ]]; then
    warn "No A/AAAA/CNAME record found for ${name}"
    return 0
  fi
  echo "$JSON" | jq -r --arg N "${name}." '
    .ResourceRecordSets[] | select(.Name==$N and (.Type=="A" or .Type=="AAAA" or .Type=="CNAME")) |
    ("Record: " + .Name + " (" + .Type + ")"),
    (if .AliasTarget then "  Alias to: " + (.AliasTarget.DNSName // "") else empty end),
    (if .ResourceRecords then ("  Values: " + ([.ResourceRecords[].Value] | join(", "))) else empty end)
  '
  # CloudFront detection
  local is_cf=$(echo "$JSON" | jq -r --arg N "${name}." '
    .ResourceRecordSets[] | select(.Name==$N and (.Type=="A" or .Type=="CNAME")) |
    (if .AliasTarget then .AliasTarget.DNSName else (if .ResourceRecords then .ResourceRecords[0].Value else "" end) end) | tostring | contains("cloudfront.net")
  ' | head -n1)
  if [[ "$is_cf" == "true" ]]; then
    warn "${name} currently points to CloudFront (cloudfront.net)."
  fi
}

describe_name "$DOMAIN"
if $INCLUDE_WWW; then describe_name "www.$DOMAIN"; fi

if [[ -z "$IP" ]]; then exit 0; fi

CHANGE_ITEMS="[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"$IP\"}]}}]"
if $INCLUDE_WWW; then
  CHANGE_ITEMS=$(jq -cn --arg dom "$DOMAIN" --arg ip "$IP" '
    [
      {Action:"UPSERT",ResourceRecordSet:{Name:$dom,Type:"A",TTL:60,ResourceRecords:[{Value:$ip}]}},
      {Action:"UPSERT",ResourceRecordSet:{Name:("www."+$dom),Type:"A",TTL:60,ResourceRecords:[{Value:$ip}]}}
    ]
  ')
fi

echo
summ "Planned UPSERT to point ${DOMAIN}$($INCLUDE_WWW && echo " and www.${DOMAIN}") to EC2 IP ${IP}:"
echo "$CHANGE_ITEMS" | jq .

if $APPLY; then
  echo
  summ "Applying Route53 UPSERT..."
  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HZ" \
    --change-batch "{\"Changes\":$(echo "$CHANGE_ITEMS" | jq -c .)}"
  ok "Submitted DNS change. Propagation may take up to a few minutes."
else
  echo
  warn "Dry run only. Re-run with --apply to submit the DNS changes."
fi
