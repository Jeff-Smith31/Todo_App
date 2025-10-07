# TickTock Tasks

A lightweight recurring to‑do app that works offline (PWA) and optionally syncs across devices via a small backend. This guide explains what you get, how it’s deployed, step‑by‑step deployment, and the license.

What you get
- Recurring tasks: daily, weekly, monthly (approx), or custom every N days
- Reminder time per task; missed reminders roll to the next day and mark PRIORITY
- Offline‑first PWA: install to Home Screen; data stored locally if no backend
- Optional backend: accounts (email/password), sync across devices, Web Push
- Minimal UI: dedicated login page, task list page, and a separate task form page

Architecture
- Single EC2 host (now standard): One EC2 instance runs two containers via Docker Compose:
  - Frontend: Nginx serves the SPA for ticktocktasks.com and www.ticktocktasks.com.
  - Backend: Node.js/Express API container. The api.ticktocktasks.com hostname is routed by the Nginx container directly to the backend container.
- Backend health is exposed at /healthz on api.ticktocktasks.com and at /api/healthz via the frontend host (apex/www) proxy. The SPA uses same‑origin /api/* when loaded from apex/www.
- Auto‑connect: The frontend reads window.RUNTIME_CONFIG.BACKEND_URL from config.js at the site root. In this setup it is empty so API calls go to same‑origin /api/*.

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

CloudWatch Logs (frontend)
- The nginx container now ships access and error logs to Amazon CloudWatch Logs using the awslogs driver.
- Requirements: the EC2 instance role (or credentials on the host) must allow logs:CreateLogGroup, logs:CreateLogStream, and logs:PutLogEvents in your region.
- Log group name (default): /TickTock/Frontend-${DOMAIN_NAME:-ticktocktasks.com}
- Region: ${AWS_REGION:-us-east-1}
- View logs: open CloudWatch Logs > Log groups > /TickTock/Frontend-<your-domain> to see access lines (2xx/3xx/4xx/5xx) and Nginx error messages when loading the page.
- Tip: Trigger entries by hitting https://<your-domain>/ and watch for corresponding access/error log entries.

HTTPS and certificate checks
- Use the Bash script to verify HTTPS and certificate validity:
  - ./scripts/check-dns-and-http.sh your-domain.com [EC2_PUBLIC_IP]
- The script reports the HTTPS status code and ssl_verify_result (0 means certificate validated successfully).

Switch Route53 from CloudFront to EC2
- If your hosted zone still points ticktocktasks.com or www.ticktocktasks.com to a cloudfront.net target, switch them to A records that point to your EC2 public IP.
- Bash (Linux/macOS):
  - Dry run (shows what will change):
    ./scripts/route53-switch-to-ec2.sh -z <HOSTED_ZONE_ID> -d ticktocktasks.com -i <EC2_PUBLIC_IP> --include-www
  - Apply changes:
    ./scripts/route53-switch-to-ec2.sh -z <HOSTED_ZONE_ID> -d ticktocktasks.com -i <EC2_PUBLIC_IP> --include-www --apply
- PowerShell (Windows):
  - Dry run:
    powershell -ExecutionPolicy Bypass -File .\scripts\route53-switch-to-ec2.ps1 -HostedZoneId <HOSTED_ZONE_ID> -Domain ticktocktasks.com -Ec2Ip <EC2_PUBLIC_IP> -IncludeWww
  - Apply changes:
    powershell -ExecutionPolicy Bypass -File .\scripts\route53-switch-to-ec2.ps1 -HostedZoneId <HOSTED_ZONE_ID> -Domain ticktocktasks.com -Ec2Ip <EC2_PUBLIC_IP> -IncludeWww -Apply
- CI enforcement (GitHub Actions):
  - The deploy workflow now fails early if USE_CLOUDFRONT=false and Route53 records still point to CloudFront. To allow the workflow to auto-fix, set repository Variables:
    - FIX_DNS_TO_EC2=true
    - EC2_PUBLIC_IP=<your EC2 public or Elastic IP>
  - You can relax this behavior by setting DNS_ENFORCE_STRICT=false in repo Variables (not recommended).

License
This project is licensed under the MIT License. See LICENSE for details.


Note (2025-10-06): CI default now auto-fixes Route53 when not using CloudFront.
- The deploy workflow defaults FIX_DNS_TO_EC2=true. If USE_CLOUDFRONT=false and your hosted zone still points to a cloudfront.net alias, the workflow will UPSERT A records for the apex and www to your EC2 public IP. It auto-resolves the IP from the backend CloudFormation stack if EC2_PUBLIC_IP is unset.
- To opt out of automatic DNS changes, set repo Variable FIX_DNS_TO_EC2=false (or relax enforcement with DNS_ENFORCE_STRICT=false, not recommended).


Troubleshooting: EC2 instance type unsupported in AZ
- If CloudFormation fails with an error like: "Your requested instance type (t3.micro) is not supported in your requested Availability Zone (...)", it means the selected SubnetId is in an AZ that doesn’t offer that instance type in your account.
- Fix options:
  - Use the default t2.micro (now the default for the frontend EC2 template), which is broadly available.
  - Or choose a different SubnetId that resides in a supported AZ for t3.micro (e.g., us-east-1a/1b/1c/1d/1f in us-east-1 per the error message).
- The backend stack already defaults to t2.micro. The dedicated frontend-ec2 stack has been updated to also default to t2.micro while still allowing t3.micro.
