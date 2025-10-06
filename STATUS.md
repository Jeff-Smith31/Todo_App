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
