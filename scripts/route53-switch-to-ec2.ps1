<#!
.SYNOPSIS
  Route53 helper to switch a domain's A record(s) from CloudFront to EC2 Nginx.

.USAGE
  powershell -ExecutionPolicy Bypass -File .\scripts\route53-switch-to-ec2.ps1 -HostedZoneId <HZ> -Domain <DOMAIN> -Ip <EC2_PUBLIC_IP> [-IncludeWww] [-Apply]
#>

param(
  [Parameter(Mandatory=$true)] [string]$HostedZoneId,
  [Parameter(Mandatory=$true)] [string]$Domain,
  [Parameter(Mandatory=$false)] [string]$Ip,
  [switch]$IncludeWww,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Header($t){ Write-Host "`n== $t ==" }
function Ok($t){ Write-Host "[OK] $t" -ForegroundColor Green }
function Warn($t){ Write-Host "[WARN] $t" -ForegroundColor Yellow }
function Err($t){ Write-Host "[ERR] $t" -ForegroundColor Red }

Header "Checking Route53 records for $Domain in zone $HostedZoneId"
$json = aws route53 list-resource-record-sets --hosted-zone-id $HostedZoneId | ConvertFrom-Json

function Describe-Name($name,[object]$json){
  $records = $json.ResourceRecordSets | Where-Object { $_.Name -eq ("$name." ) -and ($_.Type -in @('A','AAAA','CNAME')) }
  if (-not $records) { Warn "No A/AAAA/CNAME record found for $name"; return }
  foreach($r in $records){
    Write-Host ("Record: {0} ({1})" -f $r.Name,$r.Type)
    if ($r.AliasTarget) { Write-Host ("  Alias to: {0}" -f $r.AliasTarget.DNSName) }
    if ($r.ResourceRecords) { Write-Host ("  Values: {0}" -f ($r.ResourceRecords | ForEach-Object {$_.Value} -join ', ')) }
    $target = if ($r.AliasTarget) { $r.AliasTarget.DNSName } elseif ($r.ResourceRecords) { ($r.ResourceRecords[0].Value) } else { '' }
    if ($target -match 'cloudfront\.net\.?$') { Warn "$name currently points to CloudFront (cloudfront.net)." }
  }
}

Describe-Name $Domain $json
if ($IncludeWww) { Describe-Name ("www.$Domain") $json }

if (-not $Ip) { return }

$changes = @(
  @{ Action = 'UPSERT'; ResourceRecordSet = @{ Name = $Domain; Type = 'A'; TTL = 60; ResourceRecords = @(@{ Value = $Ip }) } }
)
if ($IncludeWww) {
  $changes += @{ Action = 'UPSERT'; ResourceRecordSet = @{ Name = "www.$Domain"; Type = 'A'; TTL = 60; ResourceRecords = @(@{ Value = $Ip }) } }
}

Header "Planned UPSERT to point $Domain$((if($IncludeWww){" and www.$Domain"} else {""})) to EC2 IP $Ip"
$changes | ConvertTo-Json -Depth 5 | Write-Host

if ($Apply) {
  Header "Applying Route53 UPSERT..."
  $batch = @{ Changes = $changes } | ConvertTo-Json -Depth 5 -Compress
  aws route53 change-resource-record-sets --hosted-zone-id $HostedZoneId --change-batch $batch | Out-Null
  Ok "Submitted DNS change. Propagation may take a few minutes."
} else {
  Warn "Dry run only. Re-run with -Apply to submit the DNS changes."
}
