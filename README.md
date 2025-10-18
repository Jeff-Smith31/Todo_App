# TickTock Tasks

A lightweight recurring to‑do app that works offline (PWA) and optionally syncs across devices via a small backend. This guide explains what you get, how it’s deployed, step‑by‑step deployment, and the license.

What you get
- Recurring tasks: daily, weekly, monthly (approx), or custom every N days
- Reminder time per task; missed reminders roll to the next day and mark PRIORITY
- Offline‑first PWA: install to Home Screen; data stored locally if no backend
- Optional backend: accounts (email/password), sync across devices, Web Push
- Minimal UI: dedicated login page, task list page, and a separate task form page

Architecture
- Frontend: Deployed to Amazon S3 and served globally via Amazon CloudFront (ACM certificate in us-east-1 and Route53 aliases for apex and www).
- Backend: Single EC2 instance running the Node.js/Express API (Docker). Public HTTPS is exposed at api.<DomainName> with DNS via Route53.
- CORS: The backend allows origins for https://<DomainName>, https://www.<DomainName>, and the CloudFront domain by default (configurable).
- Frontend config: window.RUNTIME_CONFIG.BACKEND_URL in frontend/website/config.js can be set by CI to point to the API hostname; otherwise the app can be served relative if proxied.

Quick start (frontend only)
- From the frontend/website directory, serve the site locally:
  - cd frontend/website && python3 -m http.server 8000
  - Open http://localhost:8000
- Click “Enable Notifications” if prompted, then create tasks. Data stays on this device (localStorage) until you connect a backend.

Run the backend locally (Docker)
- One‑liner start (pass your frontend origin for CORS):
  - bash backend/backend-up.sh http://localhost:8000
  - First run may need: chmod +x backend/backend-up.sh
- The backend exposes HTTPS on 8443 (self‑signed dev cert) and optionally redirects 8080→8443.
- Reverse proxy/TLS: Caddy is the supported option.
  - Start Caddy locally (optional): cd backend && docker compose --profile proxy up -d caddy
    - Or run: bash backend/caddy-up.sh
  - If you previously had a directory named Caddyfile in this folder, remove it: rm -rf Caddyfile.
  - Troubleshooting: If you see “no configuration file provided: not found”, you’re likely running docker compose outside the backend directory. Use cd backend … or pass -f backend/docker-compose.yml.
- Trust the cert once by visiting https://localhost:8443 in your browser.
- Connect the frontend (choose one):
  - Easiest for dev: open your browser console on http://localhost:8000 and run:
    localStorage.setItem('tt_backend_url','https://localhost:8443'); location.reload();
  - Or create a config.js at the site root with:
    window.RUNTIME_CONFIG = { BACKEND_URL: 'https://localhost:8443' };
- Sign up or log in; your tasks will sync between devices that use the same backend URL and account.

Backend configuration (.env)
- Created/updated by backend-up.sh on first run:
  - CORS_ORIGIN: your frontend origin(s) (single or comma‑separated list)
  - JWT_SECRET: strong random secret (auto‑generated if absent)
  - WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY: VAPID keys for Web Push (auto‑generated when npx web-push is available)
  - REDIRECT_HTTP_TO_HTTPS: true/false (default true inside container; set false when behind TLS proxy)

Production deployment on AWS (CloudFront + S3 frontend, EC2 backend)
The frontend is deployed to S3 and served globally via CloudFront (ACM in us-east-1, Route53 aliases for apex and www). The backend API runs on a single EC2 instance at api.<DomainName>.

1) Provision stacks
- Frontend (S3 + CloudFront): deploy infra/frontend/template.yaml in us-east-1. Provide DomainName, HostedZoneId, and optionally ExistingCertificateArn/ExistingBucketName.
- Backend (EC2 API): deploy infra/backend/template.yaml to your region. This creates api.<DomainName> and exposes HTTPS.

2) Deploy frontend
- Use GitHub Actions workflow: "Frontend Deploy to S3 + CloudFront" (workflow_dispatch). It will:
  - Sync ./frontend/website to the S3 bucket
  - Write config.js with BACKEND_URL pointing to the API endpoint (https://api.<DomainName>)
  - Invalidate CloudFront so new assets are served
- Alternatively, deploy manually:
  - aws s3 sync frontend/website s3://<your-bucket>
  - BACKEND_OVERRIDE_URL=https://api.<DomainName> infra/scripts/link-frontend.sh <FRONT_STACK> <BACK_STACK>

3) CORS and config
- The backend AllowedOrigins should include https://<DomainName>, https://www.<DomainName>, and the CloudFront domain.
- The app reads window.RUNTIME_CONFIG.BACKEND_URL from config.js set during deploy; with this, login and task syncing work from CloudFront.

4) Verify
- Browse https://<DomainName>/ → app loads
- Log in → Network shows calls to https://api.<DomainName>/api/* succeeding
- Family tab shows your group code and tasks

5) Updates
- Re-run the GitHub workflow after pushing changes to frontend/website to publish updates globally via CloudFront.
- Or deploy manually via scripts:
  - Linux/macOS: ./scripts/deploy-frontend.sh <S3_BUCKET_NAME> <CLOUDFRONT_DISTRIBUTION_ID> [--path frontend/website]
  - Windows PowerShell: powershell -ExecutionPolicy Bypass -File .\scripts\deploy-frontend.ps1 -BucketName <S3_BUCKET_NAME> -DistributionId <DISTRIBUTION_ID> [-Path frontend\website]
- Backend updates: run backend/backend-up.sh on the EC2 host to rebuild (no cache) and force-recreate the backend container so new code is active.

TLS for API (login failures: "Failed to fetch" or ERR_CONNECTION_REFUSED)
- If the app at https://<DomainName> shows "Failed to fetch" or the browser reports net::ERR_CONNECTION_REFUSED when calling https://api.<DomainName>, ensure the API has a valid TLS cert and is listening on port 443.
- Use the GitHub Action "Issue/Renew API TLS Cert (Let’s Encrypt)" (workflow_dispatch) with your backend stack name and domain to issue/renew certs on the EC2 host via SSM, then retry login.
- Alternatively SSH to the EC2 host and run: scripts/issue-certs.sh <DomainName> --include-api; then reload Nginx: docker compose exec nginx nginx -s reload.
- Ensure the EC2 Security Group allows inbound TCP 443 (and 80) from 0.0.0.0/0 (and ::/0). If 443 is blocked or Nginx is not bound, HTTPS calls from the frontend will fail.

DNS and routing checks
- Use the provided scripts to validate DNS and Nginx reachability from outside and from EC2:
  - Linux/macOS: ./scripts/check-dns-and-http.sh your-domain.com [EC2_PUBLIC_IP]
  - Windows PowerShell: powershell -ExecutionPolicy Bypass -File .\scripts\check-dns-and-http.ps1 -Domain your-domain.com [-Ec2Ip EC2_PUBLIC_IP]
- The script verifies A/AAAA records, checks that the A record matches your EC2 IP (if provided), confirms HTTP and /nginx-healthz are reachable, and now also checks HTTPS https://api.<DomainName>/healthz on port 443 with guidance if it fails.
- If checks fail, ensure:
  - Route53 (or your DNS) A record points to the EC2 public or Elastic IP
  - EC2 security group allows inbound TCP 80 from 0.0.0.0/0 (and ::/0)
  - docker compose ps shows nginx up and listening on 0.0.0.0:80

CloudFront + S3 frontend (optional advanced setup)
- The infra/frontend/template.yaml now supports proxying the API through CloudFront when you set the parameter BackendAlbDnsName (the DNS name of your backend ALB).
- When BackendAlbDnsName is set, CloudFront routes /api/* to the backend origin with no caching and forwards Authorization headers, cookies, and query strings.
- The app reads BACKEND_URL from frontend/website/config.js. Leave it empty to use same-origin (recommended with CloudFront /api path), or set to a full https URL to talk to a separate API domain.

Offline behavior
- A dedicated offline page (offline.html) is shown when there’s no internet connection. It uses the same CSS to preserve the app’s look and feel. The service worker precaches required assets and falls back to offline.html on navigations when offline.

License
This project is licensed under the MIT License. See LICENSE for details.
