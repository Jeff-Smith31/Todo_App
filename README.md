# TickTock Tasks

A lightweight recurring to‑do app that works offline (PWA) and optionally syncs across devices via a small backend. This guide explains what you get, how it’s deployed, step‑by‑step deployment, and the license.

What you get
- Recurring tasks: daily, weekly, monthly (approx), or custom every N days
- Reminder time per task; missed reminders roll to the next day and mark PRIORITY
- Offline‑first PWA: install to Home Screen; data stored locally if no backend
- Optional backend: accounts (email/password), sync across devices, Web Push
- Minimal UI: dedicated login page, task list page, and a separate task form page

Architecture
- Frontend: Static HTML/CSS/JS with a Service Worker and Web App Manifest. Served by Nginx on the same EC2 instance as the backend in production (and can be served locally for dev).
- Backend: Node.js/Express API (Dockerized) with DynamoDB persistence and Web Push. Nginx proxies /api/* to the backend container.
- Auto‑connect: The frontend reads window.RUNTIME_CONFIG.BACKEND_URL from config.js at the site root. In the Nginx setup this is set to empty string, meaning same‑origin requests to /api/*.

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

Production deployment on AWS (single EC2: Nginx serves frontend + backend API)
This setup removes CloudFront/S3. The frontend is served by Nginx on the same EC2 instance as the backend. Route53 can point your apex or app subdomain directly to the EC2 public IP or an Elastic IP.

1) Provision backend EC2 (free‑tier) and start services
- SSH into the instance and clone this repo (or use your existing CI/CD to pull updates).
- Ensure Docker and Docker Compose are installed.
- From the repo root, create a .env file (optional) to set CORS_ORIGIN to your site’s URL(s):
  CORS_ORIGIN=https://your-domain.com,https://www.your-domain.com
- Start the stack:
  docker compose up -d --build
- This runs two containers:
  - backend (Express API on 8080 inside the network)
  - nginx (serves frontend from frontend/website and proxies /api/* to backend)

2) TLS (HTTPS on frontend)
- HTTPS is enabled in nginx with Let’s Encrypt certs. We use the ACME webroot at /var/www/certbot (mapped to the certbot_challenges volume) and expect certs under /etc/letsencrypt (mapped to the letsencrypt volume).
- One-time issue certificate (replace DOMAIN with your real domain):
  docker compose run --rm \
    -p 80:80 \
    -v certbot_challenges:/var/www/certbot \
    -v letsencrypt:/etc/letsencrypt \
    nginx sh -c "apk add --no-cache certbot && certbot certonly --webroot -w /var/www/certbot -d DOMAIN -d www.DOMAIN --agree-tos -m admin@DOMAIN --non-interactive"
- Update nginx.conf server_name and certificate paths if your domain differs from ticktocktasks.com.
- Reload nginx after certs are obtained: docker compose exec nginx nginx -s reload
- 443 is exposed by docker-compose. HTTP (80) redirects to HTTPS, while ACME challenges and health endpoints remain available on HTTP.

3) DNS
- Create A/AAAA records in Route53 (or your DNS) to point your domain to the EC2 public IP/Elastic IP.

4) Frontend configuration
- The file frontend/website/config.js sets BACKEND_URL to empty string, so the web app uses same-origin requests to /api/* via Nginx. No CloudFront is used anymore.

5) Deploy updates
- Pull latest code and run docker compose up -d --build to redeploy. Static files are served live from ./frontend/website mounted into Nginx.

Verify
- Open http://your-domain.com (HTTP) to verify reachability. If you need HTTPS, complete TLS setup first, then add and expose the 443 listener.
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
