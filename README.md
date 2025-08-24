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

Development tips
- The app reads the backend URL in this order: window.RUNTIME_CONFIG.BACKEND_URL → window.BACKEND_URL → localStorage.tt_backend_url → '' (local‑only mode).
- For quick local testing, set localStorage.tt_backend_url and reload. For production, prefer config.js via link-frontend.sh.

License
This project is licensed under the MIT License. See LICENSE for details.
