# TickTock Tasks

A lightweight recurring to‑do app that works offline (PWA) and optionally syncs across devices via a small backend. This guide explains what you get, how it’s deployed, step‑by‑step deployment, and the license.

What you get
- Recurring tasks: daily, weekly, monthly (approx), or custom weekdays (choose specific days of week)
- Reminder time per task; missed reminders roll to the next day and mark PRIORITY
- Offline‑first PWA: install to Home Screen; data stored locally if no backend
- Optional backend: accounts (email/password), sync across devices, Web Push
- Minimal UI: dedicated login page, task list page, and a separate task form page

Architecture
- Frontend: Static HTML/CSS/JS with a Service Worker and Web App Manifest. Served from any static host (locally or S3+CloudFront in production).
- Backend (optional): Node.js/Express with DynamoDB (Dockerized), no local database persistence required. Secure defaults (CORS with credentials, JWT cookie/session auth). Web Push subscribe endpoints provided (VAPID key exposure when configured).
- Auto‑connect: The frontend reads window.RUNTIME_CONFIG.BACKEND_URL from an optional config.js file at the site root. We provide a script that writes this file during deployment so the frontend is automatically connected to the backend without manual edits.

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
- Reverse proxy/TLS: Nginx + Certbot is the supported option.
  - Start Nginx locally (optional): docker compose up -d nginx
    - Note: Local dev uses HTTP-only nginx.conf by default and proxies to the backend on 8080.
  - Troubleshooting: If you see “no configuration file provided: not found”, run docker compose from the repo root or pass -f accordingly.
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
- Upload the site to S3 (sync only the website folder):
  aws s3 sync frontend/website s3://<BucketName>

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
  - Reuse-friendly: if an API Route53 record already exists, the template can skip creating it (CreateApiDnsRecord=false). Our GitHub workflow auto-detects and sets this to avoid conflicts.

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

License
This project is licensed under the MIT License. See LICENSE for details.

Backend status quick check
- scripts/check-backend.sh https://api.ticktocktasks.com
- Or via npm: BACKEND_URL=https://api.ticktocktasks.com npm run check:backend


## TTT Family app:

- Code location
  - API routes: backend/index.js (section marked `--- TTT Family API ---`). Endpoints include:
    - GET /api/family/tasks
    - POST /api/family/tasks
    - DELETE /api/family/tasks/:id
    - POST /api/family/tasks/:id/complete
    - GET /api/family/associations
    - POST /api/family/associations
    - GET /api/family/analytics?range=day|week|month
  - Data tables (DynamoDB): backend/dynamo.js defines tables created automatically on startup:
    - <prefix>-family-tasks
    - <prefix>-family-logs
    - The prefix is controlled by env var DDB_TABLE_PREFIX (default: `ttt`).

### Run the TTT Family app locally (preview on your laptop/phone)

- Quick preview (no backend required):
  1) Start the local dev server that serves the main site and the Family app together:
     - node scripts/serve-family.js --port 8000
  2) Open the Family app in your browser/phone:
     - http://localhost:8000/family/
  3) You can install it as a PWA from Chrome (⋮ → Install app) or Add to Home Screen on iOS.

- Optional: Connect to a local backend for login and data
  1) Start the backend in Docker (self-signed HTTPS):
     - bash backend/backend-up.sh http://localhost:8000
  2) Start the dev server and point the Family app to that backend:
     - node scripts/serve-family.js --port 8000 --backend https://localhost:8443
  3) Open http://localhost:8000/family/ and use Login. You may need to trust the self-signed cert once by visiting https://localhost:8443 in your browser.

Notes
- The dev server sets /family/config.js at runtime, so you don’t need to edit any files to switch backends.
- Service worker is served from the site root (/sw.js) to match production behavior. If you need to hard-refresh updates, use the Update button in the UI or do a “Empty cache and hard reload” in DevTools.
