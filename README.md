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
- By default, HTTP (port 80) is available so the site is reachable even before certs are issued.
- To enable real HTTPS (no self-signed), use Let's Encrypt via the provided script (ACME webroot):
  - scripts/issue-certs.sh ticktocktasks.com
  - This issues a certificate for ticktocktasks.com and www.ticktocktasks.com and reloads Nginx.
  - To also issue an API cert: scripts/issue-certs.sh ticktocktasks.com --include-api
- ACM note: AWS Certificate Manager (ACM) certs cannot be attached directly to Nginx on EC2. If you must use ACM, terminate TLS on an AWS load balancer (ALB) or CloudFront and proxy to the instance over HTTP. For the single-EC2 setup, Let's Encrypt is the supported approach.
- Verify HTTPS:
  - curl -I http://ticktocktasks.com/ → 200
  - curl -kI https://ticktocktasks.com/ → 200 (valid cert; browser shows secure lock)
  - Optional API: curl -kI https://api.ticktocktasks.com/healthz → 200 if API cert was issued and API HTTPS is configured.
- If HTTPS fails, check that cert files exist in /etc/letsencrypt/live/<domain>/ inside the nginx container and review container logs.

3) DNS
- Create A/AAAA records in Route53 (or your DNS) to point your domain to the EC2 public IP/Elastic IP.

4) Frontend configuration
- The file frontend/website/config.js sets BACKEND_URL to empty string, so the web app uses same-origin requests to /api/* via Nginx. No CloudFront is used anymore.

5) Deploy updates
- Pull latest code and run docker compose up -d --build to redeploy. Static files are served live from ./frontend/website mounted into Nginx.

Verify
- Open http://your-domain.com (HTTP) to verify reachability. If you need HTTPS, complete TLS setup first, then add and expose the 443 listener.
- Push notifications require VAPID keys on the backend and user permission in the browser (Enable Notifications).

DNS and routing checks
- Use the provided scripts to validate DNS and Nginx reachability from outside and from EC2:
  - Linux/macOS: ./scripts/check-dns-and-http.sh your-domain.com [EC2_PUBLIC_IP]
  - Windows PowerShell: powershell -ExecutionPolicy Bypass -File .\scripts\check-dns-and-http.ps1 -Domain your-domain.com [-Ec2Ip EC2_PUBLIC_IP]
- The script verifies A/AAAA records, checks that the A record matches your EC2 IP (if provided), and confirms HTTP and /nginx-healthz are reachable.
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
