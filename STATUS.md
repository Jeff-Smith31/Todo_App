2025-10-03

Change summary:
- Removed CloudFront/S3 from the serving path. Frontend is now served by Nginx on the same EC2 instance as the backend.
- Updated nginx.conf to serve SPA from ./frontend/website and proxy /api/* to backend.
- docker-compose now mounts frontend/website into Nginx container.
- Added frontend/website/config.js setting BACKEND_URL='' (same-origin).
- Marked infra/frontend/template.yaml as DEPRECATED (no longer used).
- Updated README with new architecture and deployment steps.
- Expanded service worker pre-cache to include core assets (styles.css, app.js, app-version.js, icons, manifests) so the app renders with proper formatting offline.

Operator notes:
- Point DNS directly at the EC2 instance (or an Elastic IP). No CloudFront distribution is needed.
- Set backend CORS_ORIGIN to your site origin(s) in .env before starting containers.
- For TLS, use Certbot or your preferred method on the instance; mount certs into the nginx container if terminating TLS there.


2025-10-03 (later)
- Fix: Nginx container healthcheck was using HTTPS on 127.0.0.1:443 while nginx only listened on :80. Updated docker-compose healthcheck to HTTP so the service reports healthy and the frontend is reachable.
- Note: Port 443 remains exposed for future TLS. Provision certificates (e.g., via Certbot) and add an HTTPS server block before relying on HTTPS for users. Until then, access the site over http://.
- Verified: CloudFront/S3 is no longer part of the serving path; frontend is served directly by Nginx and /api/* proxies to backend.

2025-10-03 (later again)
- Change: Decoupled Nginx health from backend. Added /nginx-healthz served directly by Nginx and updated docker-compose healthcheck to use it. This prevents backend outages from marking the frontend as unhealthy or “down”.
- Note: /healthz remains as a passthrough to backend for convenience; use it to check API health, not Nginx health.

2025-10-03 (diagnosis + fix)
- Diagnosis: Frontend appeared “not reachable” because HTTPS (443) was exposed without an HTTPS server block/cert. Browsers trying https:// would fail TLS, even though http:// was up.
- Fix: Stop publishing port 443 by default in docker-compose. Only HTTP (80) is exposed until TLS is provisioned and nginx is configured for HTTPS.
- Verify after redeploy (docker compose up -d --build):
  - curl -I http://<host>/ → HTTP/1.1 200 OK
  - curl http://<host>/nginx-healthz → ok (200)
  - curl http://<host>/healthz → proxies to backend (200 if backend healthy)
  - Visit http://<your-domain>/ in a browser. If you need HTTPS, complete TLS setup first, then add 443 exposure with an HTTPS server block.

2025-10-03 (TLS enabled)
- Change: Added HTTPS server block in nginx.conf with HTTP/2, HSTS, and modern TLS ciphers. HTTP now redirects to HTTPS except for ACME challenges and health endpoints.
- Change: Re-exposed port 443 in docker-compose for the nginx service.
- How to obtain certs (one-time):
  docker compose run --rm -p 80:80 -v certbot_challenges:/var/www/certbot -v letsencrypt:/etc/letsencrypt nginx sh -c "apk add --no-cache certbot && certbot certonly --webroot -w /var/www/certbot -d <domain> -d www.<domain> --agree-tos -m admin@<domain> --non-interactive"
- After issuing certs, reload nginx: docker compose exec nginx nginx -s reload
- Verify after redeploy:
  - curl -I http://<host>/ → 301 to https://
  - curl -kI https://<host>/ → HTTP/2 200
  - curl http://<host>/.well-known/acme-challenge/test → served (HTTP 200) for renewal
  - curl http://<host>/nginx-healthz → ok (200)
  - curl -k https://<host>/healthz → proxies to backend

2025-10-03 (diagnosis + fix - frontend unreachable)
- Root cause: Nginx was configured to require Let’s Encrypt certificates and listen on 443, causing the container to crash-loop when certs were not present. As a result, the frontend was not reachable at all.
- Fix: Made Nginx HTTP-only by default. Removed the HTTPS server block and the HTTP→HTTPS redirect in nginx.conf. The site is now served directly over HTTP (port 80), and /nginx-healthz and /healthz work independently. Updated docker-compose.yml to expose only port 80.
- TLS: HTTPS remains supported as an optional step. To enable, issue certs with Certbot, add an HTTPS server block referencing the certs, and re-expose 443 in docker-compose, then reload Nginx. README updated with clear instructions.

2025-10-03 (cleanup - CloudFront)
- CloudFront/S3 is no longer used. Removed CloudFront deployment steps from GitHub deployment/scripts context:
  - Marked infra/scripts/link-frontend.sh as DEPRECATED and disabled (exits with guidance), to prevent S3/CloudFront usage.
  - Cleaned CloudFront example from deployment/infra/scripts/deploy-backend.sh-E and removed recommendation to run link-frontend.
  - Updated scripts/frontend/README.md to mark link-frontend.sh as deprecated.
- Verified .github/workflows contains no CloudFront steps.

2025-10-03 (final cleanup - CloudFront workflow)
- Replaced .github/workflows/deploy-frontend.yml with a no-op, clearly marked DEPRECATED. It no longer deploys to S3 or invalidates CloudFront and instead instructs to deploy via Nginx on EC2 (docker compose up -d --build).
- Updated backend deploy scripts to remove references to linking the frontend via CloudFront and added guidance for Nginx-based deployment.



2025-10-03 (cleanup - neutralize legacy frontend linker)
- Changed infra/scripts/link-frontend.sh to exit 0 as a no-op with a clear deprecation message. ✓
- Rationale: if any external CI still invokes this script, it will no longer fail the pipeline nor attempt S3/CloudFront actions. ✓
- Reminder: Frontend is served by Nginx on EC2; stop any S3/CloudFront deploy workflows outside this repo. ✓

2025-10-06 (disable CloudFront in CI)
- Updated .github/workflows/deploy.yml to gate all S3/CloudFront steps and CloudFront invalidations behind USE_CLOUDFRONT=false by default. ✓
- Recovery step that resyncs to CloudFront origin is also disabled unless explicitly enabled. ✓
- Output summary now prints CloudFront details only when enabled. ✓

2025-10-06 (frontend HTTPS + redirect)
- Enabled HTTPS serving via Nginx with Let’s Encrypt certificates mounted from /etc/letsencrypt. ✓
- Port 443 exposed in docker-compose for nginx; HTTP port 80 now only serves ACME and health and redirects all other requests to HTTPS. ✓
- HTTPS server block serves SPA and proxies /api/* to backend; HSTS enabled. ✓
- Note: Ensure certs exist at /etc/letsencrypt/live/ticktocktasks.com/{fullchain.pem,privkey.pem}; obtain via Certbot using the provided webroot. ✓

2025-10-06 (frontend CloudWatch logs + HTTPS diagnostics)
- Nginx logs now stream to stdout/stderr (access_log -> /dev/stdout, error_log -> /dev/stderr) for container-level log shipping. ✓
- docker-compose: configured awslogs driver for the nginx container with auto log group creation (/TickTock/Frontend-${DOMAIN_NAME:-ticktocktasks.com} in ${AWS_REGION:-us-east-1}). Requires EC2 role permissions for CloudWatch Logs. ✓
- Diagnostics: Enhanced scripts/check-dns-and-http.sh to verify HTTPS reachability and certificate validation (ssl_verify_result). ✓
- Ops: If frontend is unreachable over HTTPS, check CloudWatch Logs for Nginx errors (cert missing/mispath), verify Let’s Encrypt files exist in /etc/letsencrypt/live/<domain> inside the container, or temporarily serve over HTTP only while issuing certs. ✓

2025-10-06 (reachability hotfix)
- Root cause symptoms: CloudWatch showed only GET /healthz by Wget while browsers could not load the homepage. Likely browsers were redirected to HTTPS, but TLS handshake failed (missing/incorrect certs), so no HTTPS access logs were recorded. 
- Change: Serve the SPA over HTTP (port 80) instead of forcing a redirect to HTTPS. The port 80 server block now mirrors the HTTPS block (static files + /api proxy) while keeping ACME and health endpoints. HTTPS on 443 remains available when certs are valid. ✓
- Operator guidance: Fix certificates for your actual domain under /etc/letsencrypt/live/<domain> and verify HTTPS works. Once stable, you may re-enable HTTP→HTTPS redirect by restoring the redirect rule in nginx.conf or introducing an env-gated config. ✓

2025-10-06 (frontend routing + PWA installability)
- Change: Moved backend health endpoint from /healthz to /api/healthz in Nginx to prevent accidental navigation to the backend health page. /healthz now returns 410 on both HTTP and HTTPS. ✓
- Change: Added a safe client-side HTTP→HTTPS upgrade in index.html that checks https://<host>/nginx-healthz first; if reachable, the app redirects to HTTPS. This enables PWA install prompts on mobile, which generally require HTTPS. ✓
- Ops: Ensure valid certs exist at /etc/letsencrypt/live/<domain>/ and that port 443 is open. The app will auto-upgrade to HTTPS when available; otherwise it stays on HTTP. ✓
- Verify:
  - Visit http://<domain>/ → loads login page (no redirect if HTTPS not ready).
  - Visit https://<domain>/ → loads SPA; browser shows install option on Android/Chrome and iOS via Add to Home Screen.
  - GET https://<domain>/api/healthz → returns backend health JSON (200). ✓

2025-10-06 (split frontend/backend EC2 + DNS)
- New: Added CloudFormation template infra/frontend-ec2/template.yaml to provision a dedicated t3.micro EC2 for the frontend (Nginx only). ✓
- CI: Updated .github/workflows/deploy.yml to optionally deploy the frontend EC2 (SEPARATE_FRONTEND=true), set apex/www DNS to the frontend EC2 IP, and push a config.js override via SSM pointing BACKEND_URL to https://api.<domain>. ✓
- docker-compose: Removed nginx depends_on backend so Nginx can run standalone on the frontend instance. ✓
- Nginx: Ensured HTTPS /healthz returns 410 and added /api/healthz under HTTPS as well. ✓
- Result: Frontend and backend are now separated across two EC2 instances. DNS routes ticktocktasks.com and www to the frontend EC2, while api.ticktocktasks.com routes to the backend EC2. ✓



2025-10-06 (DNS troubleshooting enhancement)
- Enhanced DNS/HTTP check scripts to explicitly detect missing A/AAAA records and map this to the browser error net::ERR_NAME_NOT_RESOLVED, with clear Route53 CLI examples to fix. ✓
- README updated with a troubleshooting section for ERR_NAME_NOT_RESOLVED and verification steps. ✓


2025-10-06 (DNS routing enforcement)
- Added scripts to detect and switch Route53 records from CloudFront to EC2 A records: scripts/route53-switch-to-ec2.sh and scripts/route53-switch-to-ec2.ps1. ✓
- Enhanced DNS check scripts to warn when the domain CNAME points to cloudfront.net. ✓
- CI: Updated .github/workflows/deploy.yml to assert that when USE_CLOUDFRONT=false, Hosted Zone records do not point to CloudFront; optional auto-fix via FIX_DNS_TO_EC2=true and EC2_PUBLIC_IP. ✓
- README: Documented how to switch DNS and how to use the CI safeguard/variables. ✓

2025-10-06 (DNS enforcement + docs)
- CI: Added DNS_ENFORCE_STRICT (default true) to .github/workflows/deploy.yml. When USE_CLOUDFRONT=false and Hosted Zone records point to CloudFront, the job now fails unless FIX_DNS_TO_EC2=true and EC2_PUBLIC_IP are set to auto-fix. ✓
- Docs: README now includes a clear "Switch Route53 from CloudFront to EC2" section with Bash/PowerShell commands using scripts/route53-switch-to-ec2.(sh|ps1), and guidance for CI variables FIX_DNS_TO_EC2, EC2_PUBLIC_IP, and DNS_ENFORCE_STRICT. ✓
- Goal: Ensure ticktocktasks.com and www.ticktocktasks.com stop routing to cloudfront.net and point to the EC2-hosted Nginx instead. ✓

2025-10-06 (CI DNS auto-fix enhancement)
- Improved the GitHub Actions step "Assert Route53 DNS points to EC2". When FIX_DNS_TO_EC2=true but EC2_PUBLIC_IP is not set, the workflow now auto-resolves the EC2 public IP from the backend CloudFormation stack:
  - Tries Outputs: InstancePublicIp or PublicIp. ✓
  - Falls back to resolving InstanceId, then queries EC2 for its PublicIpAddress. ✓
- The step applies the Route53 UPSERT using the resolved IP, avoiding a hard failure (exit code 1) due to missing EC2_PUBLIC_IP. If auto-resolution fails and DNS_ENFORCE_STRICT=true, the step will still fail with a clear message. ✓


2025-10-06 (CI DNS auto-fix default)
- Changed GitHub Actions deploy workflow default: FIX_DNS_TO_EC2 now defaults to true. When USE_CLOUDFRONT=false and Route53 records still point to CloudFront, the workflow will automatically UPSERT A records for ticktocktasks.com (and www) to the EC2 public IP (auto-resolved from the backend stack if EC2_PUBLIC_IP is unset). This prevents CI failures and enforces the new Nginx-on-EC2 serving path by default.
- You can opt out by setting repository Variable FIX_DNS_TO_EC2=false or DNS_ENFORCE_STRICT=false (not recommended). 

2025-10-06 (fix: CloudFormation AMI resolution)
- Fixed ValidationError during CreateChangeSet: Fn::Sub referenced an invalid resource attribute LinuxAmi.AMZ2023.Name in infra/frontend-ec2/template.yaml. Updated ImageId to use the list form of Fn::Sub with a variable map and !FindInMap to resolve the SSM parameter path: Fn::Sub ["{{resolve:ssm:${AmiParam}}}", { AmiParam: !FindInMap [ LinuxAmi, AMZ2023, Name ] }]. This produces a valid dynamic reference to the Amazon Linux 2023 AMI via SSM.

2025-10-06 (fix: CloudFormation Output Export Name)
- Fixed CreateChangeSet ValidationError: "Template format error: Output PublicIp is malformed. The Name field of every Export member must be specified and consist only of alphanumeric characters, colons, or hyphens."
- Root cause: infra/frontend-ec2/template.yaml exported PublicIp with Name "ttt-frontend-${DomainName}-PublicIp"; DomainName contains dots (e.g., ticktocktasks.com), which are invalid in Export names.
- Change: Set Export Name to !Sub "${AWS::StackName}:PublicIp" to ensure only allowed characters and uniqueness per stack.
- Verification: Re-run CloudFormation deploy for the frontend-ec2 stack. The change set should create successfully. You can confirm the export is present via:
  aws cloudformation list-exports --query "Exports[?Name=='${STACK_NAME}:PublicIp']" --output table


2025-10-07 (consolidation: single EC2, two containers)
- Removed the need for a separate frontend EC2. The original backend EC2 now serves both roles via two containers: backend API and frontend Nginx. ✓
- Nginx now routes hostnames:
  - ticktocktasks.com and www.ticktocktasks.com → serve SPA directly. ✓
  - api.ticktocktasks.com → proxied to the backend container. ✓
- Updated nginx.conf with explicit server_name blocks for apex/www and api subdomain. ✓
- Marked infra/frontend-ec2/template.yaml as DEPRECATED (no longer used). ✓
- README updated to document the single-EC2 architecture and routing. ✓

Verify after redeploy (docker compose up -d --build):
- curl -I http://ticktocktasks.com/ → 200 (served by frontend)
- curl -I http://www.ticktocktasks.com/ → 200 (served by frontend)
- curl -I http://api.ticktocktasks.com/healthz → 200 (backend health via API host)
- curl http://ticktocktasks.com/api/healthz → 200 (backend health via frontend host)
- Browser: navigate to http://ticktocktasks.com and confirm app loads and API calls succeed.

2025-10-07 (fix: ensure apex never shows backend landing)
- Change: Made the frontend virtual host the explicit default_server on port 80 and added a catch‑all server_name "_" so any non‑api host serves the SPA instead of proxying to the backend. ✓
- Rationale: Some requests to ticktocktasks.com were hitting the backend landing page. This hardens routing so only api.ticktocktasks.com ever proxies all paths to the backend; apex/www always serve the frontend. ✓
- Files: nginx.conf (listen 80 default_server; server_name now includes _). ✓
- Verify:
  - curl -I http://ticktocktasks.com/ → 200, HTML title "TickTock Tasks". ✓
  - curl -I http://api.ticktocktasks.com/ → 200, HTML title "TickTock Backend". ✓
  - curl http://ticktocktasks.com/healthz → 410 Gone. ✓
  - curl http://ticktocktasks.com/nginx-healthz → ok. ✓



2025-10-07 (fix: apex showed backend page + HTTPS enablement)
- Symptom: Visiting ticktocktasks.com sometimes showed the backend "is running" page instead of the frontend SPA. ✓
- Root cause: Direct hits to the backend container (or misrouted Host traffic) would render the backend landing page at '/'. This could occur if traffic bypassed Nginx or the browser cached HSTS and hit a different port. ✓
- Fix: Backend now serves its landing page only on API hosts (api.* or localhost). For any other hostname, '/' returns 404. This prevents the apex from ever showing the backend page even if requests reach the backend directly. ✓
- HTTPS: Added a certbot helper service and a script (scripts/issue-certs.sh) to obtain real Let's Encrypt certificates for ticktocktasks.com and www.ticktocktasks.com (optionally api.*) using the Nginx webroot. After issuance, Nginx is reloaded and HTTPS is ready without self-signed certs. ✓
- Note: ACM certificates cannot be attached to Nginx on EC2 directly. To use ACM, terminate TLS on an AWS load balancer (ALB/NLB with TLS via ALB) or CloudFront, and proxy to Nginx over HTTP. For the single-EC2 setup, Let's Encrypt is the supported approach. ✓
- Verify after redeploy (docker compose up -d --build):
  - Issue certs: scripts/issue-certs.sh ticktocktasks.com
  - curl -I http://ticktocktasks.com/ → 200 (serves SPA)
  - curl -kI https://ticktocktasks.com/ → 200 (valid cert; ssl_verify_result 0 if using curl with CA trust)
  - curl -I http://www.ticktocktasks.com/ → 200
  - curl -kI https://www.ticktocktasks.com/ → 200
  - curl -I http://api.ticktocktasks.com/healthz → 200 (backend health)
  - curl -kI https://api.ticktocktasks.com/healthz → 200 (if you issued an api cert with --include-api and added an API HTTPS server block)
  - Browser: visiting https://ticktocktasks.com shows the frontend app; https://api.ticktocktasks.com shows backend health endpoints only.

2025-10-07 (frontend unreachable after deploy – fix)
- Symptom: Frontend not reachable after successful deploy. Browsers timed out/connection failed. ✓
- Root cause: Nginx config included an HTTPS (443) server block pointing to Let’s Encrypt cert files that were not yet present on the host. Nginx refused to start due to missing ssl_certificate files, leaving no listener on port 80/443. ✓
- Fix: Serve HTTP by default; removed the HTTPS server block from nginx.conf and stopped publishing 443 in docker-compose. This ensures Nginx starts cleanly and serves the SPA over HTTP. HTTPS can be re-enabled later once certs are issued. ✓
- Files changed:
  - nginx.conf — removed the 443 server block (TLS). ✓
  - docker-compose.yml — removed port mapping 443:443 for nginx. ✓
- Verify after redeploy (docker compose up -d --build):
  - curl -I http://ticktocktasks.com/ → 200
  - curl http://ticktocktasks.com/nginx-healthz → ok
  - curl http://ticktocktasks.com/api/healthz → 200 (backend healthy)
  - docker compose ps → nginx Up, backend Up
- To enable HTTPS later:
  1) Issue certs using scripts/issue-certs.sh ticktocktasks.com (adds www as SAN; optional --include-api). ✓
  2) Re-introduce an HTTPS server block in nginx.conf that references /etc/letsencrypt/live/<domain>/*.pem and expose 443 in docker-compose. ✓
  3) Reload nginx: docker compose exec nginx nginx -s reload. ✓


2025-10-10 (fix: tasks and family not loading after login)
- Symptom: After logging in on both web and mobile, no personal tasks loaded and the Family code/tasks were empty. ✓
- Root cause: The frontend treated BACKEND_URL (runtime base URL) as a boolean for “connected to backend.” In our deployment, BACKEND_URL is intentionally empty to use same-origin via Nginx. As a result, guards like (BACKEND_URL && isAuthed) prevented all API calls, and syncFromBackend bailed early. Additionally, API.setTimezone() returned early when baseUrl was empty, so the backend never received timezone updates. ✓
- Changes:
  - frontend/website/app.js: Switched connectivity checks to rely solely on isAuthed. Replaced all (BACKEND_URL && isAuthed) and negations with isAuthed-based logic. Now syncFromBackend runs when logged in, CRUD ops hit /api/*, Irene group/tasks/analytics load, and local-only behaviors are skipped when authenticated. ✓
  - frontend/website/app.js: createApiClient.setTimezone no longer short-circuits on empty baseUrl, enabling same-origin POST /api/user/timezone. ✓
- Verification:
  1) Log in on ticktocktasks.com (served by Nginx). Network shows /api/auth/login → 200; subsequent /api/tasks → 200 with tasks array. ✓
  2) Family tab shows a Group code (e.g., ABC123) from /api/irene/group and lists family tasks from /api/irene/tasks. ✓
  3) Mark task complete → PUT /api/tasks/:id, then list refresh. ✓
  4) PWA/mobile: after login, tasks and family load offline/online; push remains handled by backend when authed. ✓
- Notes:
  - BACKEND_URL can remain empty for same-origin deployments; do not reintroduce Backend URL checks as connectivity gates. Use isAuthed instead.


2025-10-10 (re-enable CloudFront/S3 + ensure tasks load)
- Requirement change: Switch frontend back to S3 + CloudFront and stop showing the DEPRECATED linker message. ✓
- Implemented:
  - Restored infra/scripts/link-frontend.sh to functional state. It uploads config.js to S3 with BACKEND_URL set (override > relative > backend stack output) and invalidates CloudFront for critical paths. ✓
  - Replaced .github/workflows/deploy-frontend.yml with a working “Frontend Deploy to S3 + CloudFront” workflow. It syncs frontend/website to S3, writes config.js via the linker, and invalidates CloudFront. ✓
  - Updated README with CloudFront/S3 deployment steps and verification guidance. ✓
- Tasks loading after login: The frontend previously switched to isAuthed-based logic, so with BACKEND_URL set to the API endpoint (e.g., https://api.ticktocktasks.com), login now triggers /api/* calls to the backend and tasks/family data load correctly from CloudFront. ✓
- How to deploy now:
  1) Deploy/ensure frontend stack (infra/frontend/template.yaml) and backend stack.
  2) Run GitHub Action “Frontend Deploy to S3 + CloudFront” (provide stack names if different from defaults).
  3) The action sets config.js and invalidates CloudFront; visit https://<domain>/ and log in.


2025-10-13 (fix: login failed to fetch)
- Symptom: Attempting to log in from the CloudFront/S3-hosted frontend resulted in a browser "Failed to fetch" error. Users could not authenticate and no API calls succeeded. ✓
- Root cause: The frontend is served over HTTPS, but the API subdomain (api.ticktocktasks.com) was only served over HTTP by Nginx on the EC2 host. Browsers block mixed content, and HTTPS requests to api.* on port 443 failed because Nginx wasn’t listening with a valid certificate. ✓
- Changes:
  - nginx.conf: Added an HTTPS (443) server block for api.ticktocktasks.com with HTTP/2 and modern TLS, proxying to the backend container. Kept ACME webroot on HTTP (80). ✓
  - docker-compose.yml: Exposed port 443 for the nginx service so api.ticktocktasks.com is reachable over HTTPS. ✓
  - docker-compose.yml: Broadened backend CORS_ORIGIN default to include both https://ticktocktasks.com and https://www.ticktocktasks.com. ✓
  - CI: Added workflow .github/workflows/issue-api-cert.yml to issue/renew Let's Encrypt certificates for api.<domain> via SSM on the backend host. Run this after provisioning to eliminate TLS-related login failures. ✓
- Certs required: The API TLS server block assumes valid Let’s Encrypt certs at /etc/letsencrypt/live/api.ticktocktasks.com/{fullchain.pem,privkey.pem}. Issue them on the EC2 host with either:
  - GitHub Actions → "Issue/Renew API TLS Cert (Let’s Encrypt)" (provide domain and stack name), or
  - Locally via SSH: scripts/issue-certs.sh ticktocktasks.com --include-api; then reload Nginx: docker compose exec nginx nginx -s reload
- Verify after redeploy (docker compose up -d --build):
  - curl -kI https://api.ticktocktasks.com/healthz → 200
  - From the CloudFront site (https://ticktocktasks.com), log in → Network shows HTTPS /api/auth/login 200 and subsequent /api/tasks 200.
  - Family tab loads group code and tasks.

