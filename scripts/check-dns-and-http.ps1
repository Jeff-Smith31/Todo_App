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
  $cnameRecord = ''
  try { $aRecords = (Resolve-DnsName -Type A $Domain -ErrorAction Stop).IPAddress } catch { }
  try { $aaaaRecords = (Resolve-DnsName -Type AAAA $Domain -ErrorAction Stop).IPAddress } catch { }
  try { $cnameRecord = (Resolve-DnsName -Type CNAME $Domain -ErrorAction Stop).NameHost } catch { }
  if ($aRecords.Count -gt 0) { Ok "A records: $($aRecords -join ' ')"; $pass++ } else { Err "No A records found."; $fail++ }
  if ($aaaaRecords.Count -gt 0) { Ok "AAAA records: $($aaaaRecords -join ' ')"; $pass++ } else { Warn "No AAAA records found (IPv6 optional)." }
  if ($cnameRecord) { Ok "CNAME: $cnameRecord" }
  if ($cnameRecord -and $cnameRecord -match 'cloudfront\.net\.?$') { Warn "DNS appears to point to CloudFront (CNAME to cloudfront.net). If your frontend is served by EC2 Nginx, update Route53 A record to your EC2 IP." }

  # If no A and no AAAA, this maps to browser error: ERR_NAME_NOT_RESOLVED
  if (($aRecords -eq $null -or $aRecords.Count -eq 0) -and ($aaaaRecords -eq $null -or $aaaaRecords.Count -eq 0)) {
    Err "No DNS records found for $Domain. This typically appears in the browser as: net::ERR_NAME_NOT_RESOLVED"
    Write-Host "`nHow to fix:" -ForegroundColor Yellow
    Write-Host "- Create an A record for $Domain in Route53 (or your DNS) pointing to your EC2 public IP." -ForegroundColor Yellow
    if ($Ec2Ip) {
      Write-Host "  Example (Route53 CLI upsert):" -ForegroundColor Yellow
      Write-Host "  aws route53 change-resource-record-sets --hosted-zone-id <HOSTED_ZONE_ID> --change-batch '{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$Domain\",\"Type\":\"A\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"$Ec2Ip\"}]}}]}'" -ForegroundColor Yellow
    } else {
      Write-Host "  Example (Route53 CLI upsert): replace <EC2_PUBLIC_IP> with your instance IP" -ForegroundColor Yellow
      Write-Host "  aws route53 change-resource-record-sets --hosted-zone-id <HOSTED_ZONE_ID> --change-batch '{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$Domain\",\"Type\":\"A\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"<EC2_PUBLIC_IP>\"}]}}]}'" -ForegroundColor Yellow
    }
    Write-Host "- Ensure the EC2 security group allows inbound TCP 80 (and 443 if using HTTPS)." -ForegroundColor Yellow
  }
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

Header "HTTPS API health (443)"
$apiHost = "api.$Domain"
try {
  $respHttps = Invoke-WebRequest -Uri "https://$apiHost/healthz" -UseBasicParsing -Method GET -TimeoutSec 10 -ErrorAction Stop
  if ([int]$respHttps.StatusCode -eq 200) { Ok "HTTPS /healthz on $apiHost returned 200"; $pass++ }
  else { Err "HTTPS /healthz on $apiHost returned HTTP $([int]$respHttps.StatusCode)"; $fail++ }
}
catch {
  $msg = $_.Exception.Message
  if ($_.Exception.Response) {
    Err "HTTPS /healthz on $apiHost returned HTTP $([int]$_.Exception.Response.StatusCode)"; $fail++
  } else {
    Err "HTTPS request to $apiHost failed: $msg"; $fail++
    Write-Host "`nCommon causes and fixes:" -ForegroundColor Yellow
    Write-Host "- No listener on 443 (Nginx not bound to 443): ensure docker compose maps 443:443 and nginx.conf has a tls server block." -ForegroundColor Yellow
    Write-Host "- TLS cert missing: run GitHub Action 'Issue/Renew API TLS Cert (Let’s Encrypt)' for $Domain, or on EC2 run scripts/issue-certs.sh $Domain --include-api and restart nginx." -ForegroundColor Yellow
    Write-Host "- Security Group blocks 443: allow inbound TCP 443 from 0.0.0.0/0 (and ::/0)." -ForegroundColor Yellow
  }
}

Header "Summary"
Write-Host "Pass: $pass  Fail: $fail"
if ($fail -gt 0) {
  Write-Host "`nGuidance:"
  Write-Host "- Ensure EC2 security group allows inbound TCP 80 and 443 from 0.0.0.0/0 (and ::/0)."
  Write-Host "- Create/verify A record for $Domain pointing to your EC2 public or Elastic IP."
  Write-Host "- On EC2: docker compose ps; docker compose logs nginx; ensure ports 80 and 443 are bound."
  Write-Host "- If HTTPS failed: run the 'Issue/Renew API TLS Cert' workflow or scripts/issue-certs.sh, then docker compose exec nginx nginx -s reload."
  Write-Host "- Verify nginx.conf listens on 80 and 443 and proxies to the backend container." 
  exit 1
} else {
  Write-Host "All checks passed. DNS/HTTP/HTTPS routing appear functional."
}