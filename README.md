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


## Diagnostics & Push Test Guide

Use the built‑in diagnostics panel to verify service worker, notification permission, and push subscription status, and to send test notifications to your phone.

Quick links
- Production diagnostics: https://ticktocktasks.com/?diag=1
- Local (when serving frontend locally on port 8000): http://localhost:8000/?diag=1

Prerequisites
- Use your phone (Android Chrome or iOS Safari in the installed PWA). Desktop push is intentionally disabled.
- Be signed in to your TickTock Tasks account in the app.
- Ensure your backend is reachable (the site should already be linked via config.js in production).

How to open the diagnostics panel
1) On your phone, open the main app URL with the query parameter diag=1:
   - Production: https://ticktocktasks.com/?diag=1
   - Local dev: http://localhost:8000/?diag=1
2) Log in if you aren’t already. The diagnostics panel appears as an overlay at the bottom of the screen when diag=1 is present.

What the diagnostics panel shows
- Service Worker status (registered/active) and version.
- Notification permission (default/denied/granted).
- Push subscription status (exists/missing) and last action result.

Sending test notifications (recommended sequence)
1) Ensure permission
   - If the panel shows permission = default or denied, tap Enable Notifications and follow prompts.
   - On iOS: Push only works in the installed PWA. If you’re in Safari, install the app (Share → Add to Home Screen), open it from the Home Screen, then enable notifications inside the installed app.
2) Re‑subscribe push
   - Tap Re‑subscribe Push. This fetches the current VAPID public key, ensures the browser PushManager subscription exists, and upserts it to the backend for your account. It also auto‑heals if the server’s key rotated.
3) Send a simple test push
   - Tap Send Test Push. You should receive a notification on your phone within a few seconds. If it fails, the panel will show an error summary.
4) Run a detailed test (per‑subscription results)
   - Tap Detailed Test. This calls the backend to send a test to each of your stored subscriptions and returns per‑subscription results (ok/status/error). Use this to identify stale or mismatched entries.
5) Recover from stale/mismatched subscriptions
   - Tap Purge Subs + Re‑subscribe. This deletes all of your stored subscriptions on the server, unsubscribes locally, recreates a fresh subscription, and then sends a test.

Interpreting common results
- Success: You should see push_send_success in the app panel and a notification on the device.
- 403 VAPID mismatch: Old subscriptions created with a different server key were removed. After Purge Subs + Re‑subscribe, Send Test Push again.
- 404/410 gone: Subscription was invalid and has been removed. Re‑subscribe Push and retry.

Troubleshooting tips
- Android
  - Make sure Battery optimization isn’t overly restrictive for the browser or the installed PWA.
  - Keep the app installed (PWA icon on Home Screen) for best reliability.
- iOS
  - Push only works from the installed PWA (iOS 16.4+). Use Add to Home Screen, then enable notifications inside the installed app.
  - If you don’t see prompts, toggle Allow Notifications in iOS Settings → Notifications → [App Name].
- Network
  - Ensure the backend URL is correct (config.js). If using local backend, trust the dev certificate at https://localhost:8443 once.

Optional: Server‑side diagnostics
- While logged in on your phone, you can hit the auth‑protected diagnostics endpoint in a desktop browser (using the same account cookies) to see computed timing/debug info:
  - /api/push/diagnose — summarizes your subscriptions and today’s expected notification windows.
  - /api/push/subscriptions — lists your stored push subscriptions (redacted).
  - /api/push/test-detailed — same detailed test called by the panel.

Notes
- The diagnostics panel is intentionally hidden for normal users and only appears when ?diag=1 is present on mobile.
- In production, CloudWatch will record push events with component=push; look for push_send_success or push_send_error for deeper debugging.
