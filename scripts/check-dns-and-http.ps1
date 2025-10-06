<#
.SYNOPSIS
  Checks DNS A/AAAA records and HTTP reachability for a domain served by Nginx on EC2.

.USAGE
  powershell -ExecutionPolicy Bypass -File .\scripts\check-dns-and-http.ps1 -Domain example.com [-Ec2Ip 1.2.3.4]
#>

param(
  [Parameter(Mandatory=$true)] [string]$Domain,
  [Parameter(Mandatory=$false)] [string]$Ec2Ip
)

$ErrorActionPreference = 'Stop'

function Header($t){ Write-Host "`n== $t ==" }
function Ok($t){ Write-Host "[OK] $t" -ForegroundColor Green }
function Warn($t){ Write-Host "[WARN] $t" -ForegroundColor Yellow }
function Err($t){ Write-Host "[ERR] $t" -ForegroundColor Red }

$pass = 0
$fail = 0

Header "DNS lookup for $Domain"
try {
  $aRecords = @()
  $aaaaRecords = @()
  try { $aRecords = (Resolve-DnsName -Type A $Domain -ErrorAction Stop).IPAddress } catch { }
  try { $aaaaRecords = (Resolve-DnsName -Type AAAA $Domain -ErrorAction Stop).IPAddress } catch { }
  if ($aRecords.Count -gt 0) { Ok "A records: $($aRecords -join ' ')"; $pass++ } else { Err "No A records found."; $fail++ }
  if ($aaaaRecords.Count -gt 0) { Ok "AAAA records: $($aaaaRecords -join ' ')"; $pass++ } else { Warn "No AAAA records found (IPv6 optional)." }
}
catch {
  Err "DNS lookup failed: $_"
  $fail++
}

if ($Ec2Ip) {
  Header "DNS matches EC2 IP"
  if ($aRecords -contains $Ec2Ip) { Ok "A record contains EC2 IP $Ec2Ip"; $pass++ }
  else { Err "A record does not include EC2 IP $Ec2Ip"; $fail++; Warn "Update your DNS (Route53) A record to point $Domain to $Ec2Ip." }
}

Header "HTTP reachability"
try {
  $resp = Invoke-WebRequest -Uri "http://$Domain" -UseBasicParsing -MaximumRedirection 0 -Method GET -TimeoutSec 10 -ErrorAction Stop
  $code = [int]$resp.StatusCode
  Ok "HTTP responded with $code"
  $pass++
}
catch {
  if ($_.Exception.Response) {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -in 200,204,301,302,401,403,404,407,500,502,503,504) {
      Ok "HTTP responded with $code (non-200 acceptable for reachability)"; $pass++
    } else {
      Err "Unexpected HTTP status: $code"; $fail++
    }
  } else {
    Err "HTTP request failed: $($_.Exception.Message)"; $fail++
  }
}

Header "Nginx container health endpoint"
try {
  $hz = Invoke-WebRequest -Uri "http://$Domain/nginx-healthz" -UseBasicParsing -Method GET -TimeoutSec 10 -ErrorAction Stop
  if ([int]$hz.StatusCode -eq 200) { Ok "/nginx-healthz returned 200 (Nginx reachable)"; $pass++ }
  else { Err "/nginx-healthz returned HTTP $($hz.StatusCode)"; $fail++ }
}
catch {
  if ($_.Exception.Response) {
    Err "/nginx-healthz returned HTTP $([int]$_.Exception.Response.StatusCode)"; $fail++
  } else {
    Err "/nginx-healthz request failed: $($_.Exception.Message)"; $fail++
  }
}

Header "Summary"
Write-Host "Pass: $pass  Fail: $fail"
if ($fail -gt 0) {
  Write-Host "`nGuidance:"
  Write-Host "- Ensure EC2 security group allows inbound TCP 80 from 0.0.0.0/0 (and ::/0)."
  Write-Host "- Create/verify A record for $Domain pointing to your EC2 public or Elastic IP."
  Write-Host "- On EC2: docker compose ps; docker compose logs nginx; ensure port 80 is bound."
  Write-Host "- Verify nginx.conf listens on 80 and serves the SPA root (already in this repo)."
  exit 1
} else {
  Write-Host "All checks passed. DNS and HTTP routing appear functional."
}