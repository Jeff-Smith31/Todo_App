# TickTock Tasks

A lightweight recurring to‑do app that works offline (PWA) and optionally syncs across devices via a small backend. This guide explains what you get, how it’s deployed, step‑by‑step deployment, and the license.

What you get
- Recurring tasks: daily, weekly, monthly (approx), or custom every N days
- Reminder time per task; missed reminders roll to the next day and mark PRIORITY
- Offline‑first PWA: install to Home Screen; data stored locally if no backend
- Optional backend: accounts (email/password), sync across devices, Web Push
- Minimal UI: dedicated login page, task list page, and a separate task form page

Architecture
- Frontend: Static HTML/CSS/JS with a Service Worker and Web App Manifest. Served from any static host (locally or S3+CloudFront in production).
- Backend (optional): Node.js + Express + SQLite (Dockerized). Secure defaults (Helmet, rate‑limits, bcrypt). Web Push supported when keys are configured.
- Auto‑connect: The frontend reads window.RUNTIME_CONFIG.BACKEND_URL from an optional config.js file at the site root. We provide a script that writes this file during deployment so the frontend is automatically connected to the backend without manual edits.

Quick start (frontend only)
- From the repo root, serve the site locally:
  - python3 -m http.server 8000
  - Open http://localhost:8000
- Click “Enable Notifications” if prompted, then create tasks. Data stays on this device (localStorage) until you connect a backend.

Run the backend locally (Docker)
- One‑liner start (pass your frontend origin for CORS):
  - bash backend-up.sh http://localhost:8000
  - First run may need: chmod +x backend-up.sh
- The backend exposes HTTPS on 8443 (self‑signed dev cert) and optionally redirects 8080→8443.
- Note: The Caddy proxy is not required for local dev and is now disabled by default. If you previously had a directory named Caddyfile in this folder, remove it: rm -rf Caddyfile. To run Caddy anyway, use: docker compose --profile proxy up -d caddy
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

Production deployment on AWS (auto‑wired frontend + free‑tier EC2 backend)
We include CloudFormation templates and helper scripts to deploy the whole stack and automatically link the frontend to the backend.

1) Frontend stack (S3 + CloudFront + ACM + Route53)
- Deploy in us‑east‑1 (ACM for CloudFront must be in us‑east‑1):
  aws cloudformation deploy \
    --region us-east-1 \
    --stack-name ttt-frontend \
    --template-file infra/frontend/template.yaml \
    --parameter-overrides DomainName=your-domain.com HostedZoneId=Z123456ABCDEFG IncludeWww=true \
    --capabilities CAPABILITY_NAMED_IAM
- Note Outputs: BucketName, DistributionId, DistributionDomainName.
- Upload the site to S3 (exclude infra, node_modules, server, etc.):
  aws s3 sync . s3://<BucketName> \
    --exclude "infra/*" --exclude "mobile/*" --exclude "node_modules/*" \
    --exclude ".git/*" --exclude "server/*" --exclude "serverless/*"

2) Backend stack (free‑tier EC2 with automatic TLS)
- Deploy to your preferred region with your VPC/Subnet:
  ./infra/scripts/deploy-backend.sh \
    ttt-backend your-domain.com Z123456ABCDEFG vpc-0123456789abcdef0 subnet-0123abcd \
    "https://your-domain.com,https://www.your-domain.com,https://<CloudFrontDomainName>" \
    api https://github.com/your/repo.git us-east-1
- What this does:
  - Creates an EC2 t2.micro with Docker and Caddy
  - Starts the backend Docker container (HTTP on 8080 inside the instance)
  - Provisions TLS for api.your-domain.com via Caddy and Route53 DNS A record
  - CORS is set to the AllowedOrigins values you pass to the script/template

3) Auto‑wire the frontend to the backend endpoint
- Write config.js to the site bucket with the backend URL from stack outputs:
  ./infra/scripts/link-frontend.sh ttt-frontend ttt-backend us-east-1
- This script:
  - Reads BackendEndpoint from the backend stack
  - Uploads config.js to s3://<BucketName>/ with BACKEND_URL set
  - Invalidates /config.js on CloudFront so clients pick it up immediately

Verify
- Open https://your-domain.com, register or log in, and create tasks.
- Push notifications require VAPID keys on the backend and user permission in the browser (Enable Notifications).

Notifications behavior
- Stages per task occurrence:
  - Day-of: a reminder is sent on the due date before the due time.
  - 1 hour before: a reminder is sent roughly one hour before the due time.
  - Due-time: a reminder is sent at the exact due time.
  - Missed: if the due time passes without completion, you receive a missed notification stating the new deadline is the same time the next day; the task is marked PRIORITY and its next due date is advanced by 1 day.
- Delivery sources:
  - With backend connected and authed: Web Push delivers these reminders even if the app is closed (requires HTTPS site, VAPID keys on backend, and user permission).
  - Local-only mode (no backend): the app schedules local notifications for the 3 stages while it’s running; if a reminder is missed, on next app open it rolls the task and shows a local missed notice.
- De-duplication: each stage per occurrence is sent once. The backend stores a per-occurrence key; the frontend stores lightweight keys in local storage.

Troubleshooting
- HTTPS on backend: ensure api.your-domain.com resolves publicly; security group allows 80/443; Caddy will fetch/renew the cert automatically.
- CORS: if you see CORS errors, confirm AllowedOrigins includes both your domain(s) and the CloudFront domain.
- Switching backends later: re-run link-frontend.sh to overwrite config.js with a new endpoint.
- Backend resilience: the EC2 deployment includes container health checks and an auto-heal sidecar to restart unhealthy containers automatically. If you still observe instability, run scripts/diagnose-backend-ssm.sh --repair to re-provision the proxy and print diagnostics.
- If health checks fail: run scripts/check-backend.sh https://api.your-domain.com for quick diagnostics (includes DNS, raw-IP with Host header, and TLS peek), and scripts/diagnose-backend-ssm.sh to collect docker ps/ports/logs and Caddyfile from the EC2 host via SSM.

Development tips
- The app reads the backend URL in this order: window.RUNTIME_CONFIG.BACKEND_URL → window.BACKEND_URL → localStorage.tt_backend_url → derived https://api.<apex-domain> (when not on localhost) → '' (local‑only mode).
- For quick local testing, set localStorage.tt_backend_url and reload. For production, prefer config.js via link-frontend.sh.

License
This project is licensed under the MIT License. See LICENSE for details.



CI/CD via GitHub Actions (auto-deploy on push)
- This repo includes .github/workflows/deploy.yml that deploys both stacks automatically on push to main and on manual workflow_dispatch.
- What it does:
  - Deploys frontend stack (S3 + CloudFront + ACM + Route53) in us-east-1.
  - Uploads site assets to S3 (infra, server, node_modules, serverless, .github excluded).
  - Computes AllowedOrigins (apex, optional www, CloudFront domain) and deploys backend stack (EC2 + Caddy TLS) in your BACKEND_REGION.
  - Auto-wires the frontend by writing config.js in the site bucket with the backend endpoint.
- Resource reuse:
  - Reuses an existing S3 bucket named <DomainName>-site if present (avoids bucket name conflicts).
  - Reuses an existing ACM certificate for the apex or wildcard in us-east-1; otherwise requests a new one.
  - Skips creating Route53 apex/www records if they already exist in the hosted zone.
  - Skips creating the api.<DomainName> Route53 A record if it already exists (backend still deploys and serves TLS).

Required GitHub settings
- Secrets:
  - AWS_ROLE_TO_ASSUME: IAM Role ARN with permissions for CloudFormation, Route53, ACM, EC2, S3, CloudFront (OIDC trusted for your repo).
- Variables (Repository → Settings → Variables):
  - DOMAIN_NAME: your apex domain (example.com). If unset, the workflow will try to infer it from the existing frontend stack or Route53 hosted zones.
  - HOSTED_ZONE_ID: Route53 hosted zone ID for the domain. If unset, the workflow will try to infer it alongside DOMAIN_NAME.
  - VPC_ID: ID of a VPC with internet access. Optional — if unset, the workflow picks the default VPC in BACKEND_REGION (or the first VPC).
  - SUBNET_ID: Public subnet ID (auto-assign public IP). Optional — if unset, the workflow chooses a public subnet in the selected VPC (DefaultForAz or MapPublicIpOnLaunch=true; otherwise the first subnet).
  - INCLUDE_WWW: 'true' or 'false' (default 'true')
  - FRONTEND_REGION: default us-east-1 (required for CloudFront ACM)
  - BACKEND_REGION: region for EC2 (defaults to us-east-1 if not set)
  - FRONTEND_STACK_NAME: optional, default ttt-frontend
  - BACKEND_STACK_NAME: optional, default ttt-backend
  - API_SUBDOMAIN: optional, default api (backend will be api.<DOMAIN_NAME>)

Notes and requirements
- The EC2 instance clones this repository to /opt/ticktock during UserData. The repository must be public or otherwise accessible from the instance. If your repo is private, either:
  - Make a public mirror, then set REPO_URL in infra/scripts/deploy-backend.sh when calling it; or
  - Modify the backend template/UserData to pull a pre-built image or artifact from S3/ECR.
- CloudFront certificate must be in us-east-1; the workflow sets FRONTEND_REGION to us-east-1 by default.
- Ensure the selected subnet is public and the security group created by the template allows ports 80/443 (it does by default).
- After the first full run, the Summary in the workflow will display the S3 bucket, CloudFront ID/domain, AllowedOrigins, and the Backend Endpoint.



Mobile/native clients (Bearer auth)
- The backend now supports both cookie auth (for web) and Authorization: Bearer tokens (for native clients).
- Token lifetime is 7 days; on 401, prompt the user to log in again and replace the stored token.

Login to obtain a token (example):
- curl -sS -X POST "https://api.your-domain.com/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'

Response:
- { "ok": true, "token": "<JWT>", "user": { "id": 1, "email": "you@example.com" } }

Use token for subsequent API calls:
- curl -sS "https://api.your-domain.com/api/tasks" \
  -H "Authorization: Bearer <JWT>"

Notes:
- CORS: Native apps and curl typically send no Origin header; the backend permits such requests. If your client does send Origin, ensure it matches one of the AllowedOrigins configured during deployment.
- Web app continues to use secure HttpOnly cookies with credentials: 'include'. Mobile should prefer Bearer tokens as shown above.

## Quick health check (no auth)
Use these commands to verify the backend is up without logging in:

- Local HTTPS (self-signed dev cert):
  - curl -sk https://localhost:8443/api/ping
- Local HTTP (if HTTP is enabled without redirect):
  - curl -sS http://localhost:8080/api/ping
- Production (replace domain if needed):
  - curl -sS https://api.ticktocktasks.com/api/ping
- Repo helper (auto-resolve stack output if URL not provided):
  - scripts/check-backend.sh https://api.ticktocktasks.com

Expected response:
- { "ok": true, "service": "ticktock-backend", "time": "<ISO>", "uptimeSec": <number> }