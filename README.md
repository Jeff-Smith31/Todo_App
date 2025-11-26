# TickTock Tasks — Deployment and Operations Guide (EC2 two‑container)

High‑level summary
- Frontend: Static PWA served from a dedicated Docker container (nginx) on the same EC2 instance as the backend. Public host: http://<DomainName> (or with TLS if enabled at Nginx).
- API backend: Node.js/Express app in a Docker container on the same EC2 instance. Public host: http://api.<DomainName>.
- Reverse proxy: An edge Nginx container listens on ports 80/443 on the EC2 host and routes requests by Host header to either the frontend container (apex) or the backend container (api). Certbot volumes are present to enable optional TLS.
- Data store: Amazon DynamoDB (on‑demand) tables created/used directly by the backend.
- Logging/observability: Containers ship logs to Amazon CloudWatch Logs using the awslogs Docker logging driver; health endpoints and a diagnostics script are provided.

Repository map (deployment‑relevant)
- docker-compose.yml — Defines three containers on EC2: backend, frontend (static site), and edge Nginx (reverse proxy), plus Certbot volumes.
- nginx.conf — Reverse proxy config for host‑based routing (apex → frontend, api → backend) and ACME challenges.
- backend/ — Backend Dockerfile, Node app, DynamoDB access layer, TLS dev entrypoint.
- frontend/website/ — Static PWA site (index.html, app.js, manifest.json, service worker, etc.).
- deploy/cfn/stack.yaml — CloudFormation template that provisions EC2, Security Groups, an Elastic IP, and Route 53 A records for api.<DomainName> and <DomainName> (apex).
- scripts/check-backend.sh — External connectivity diagnostics for the new hostnames.

Architecture overview

Request flow
1) End user visits http://<DomainName> (or https://<DomainName> if you enable TLS on the instance).
   - Route 53 points the apex A record to the EC2 Elastic IP.
   - The edge Nginx receives the request and proxies to the frontend container.
2) Frontend calls the API at http://api.<DomainName> (default configured in frontend/website/config.js; can be overridden at deploy time).
   - Route 53 points api A record to the same EC2 Elastic IP.
   - The edge Nginx receives the request and proxies to the backend container.

Containers on the EC2 host
- nginx (edge, image: nginx:alpine)
  - Listens on host ports 80 and 443 (HTTPS server blocks are not included by default; Certbot volumes are available to enable TLS later).
  - Routes by Host header:
    - apex domain (<DomainName>) → frontend container
    - api.<DomainName> → backend container
  - ACME challenges served from /var/www/certbot.
  - Health endpoint: /nginx-healthz → 200 ok.
  - Logs to CloudWatch Logs group /TickTock/Edge-<DOMAIN> via awslogs driver.

- frontend (image: nginx:alpine)
  - Serves the static site from ./frontend/website mounted read‑only at /usr/share/nginx/html.
  - No host ports exposed; only accessible through the edge Nginx by Host routing.
  - Logs to CloudWatch Logs group /TickTock/FrontendSite-<DOMAIN> via awslogs driver.

- backend (built from backend/Dockerfile)
  - Node.js/Express app (index.js), HTTP on 8080, optional self‑signed HTTPS on 8443 for dev.
  - CORS_ORIGIN defaults to http(s)://<DomainName>.
  - Logs to CloudWatch Logs group /TickTock/Backend-<DOMAIN> via awslogs driver.

Backend application details
- Language/runtime: Node.js 20 (alpine image base).
- Dev HTTPS: backend/entrypoint-https.sh generates a self‑signed cert and runs HTTPS on 8443; production uses HTTP 8080 behind the edge proxy.
- Health endpoints:
  - /healthz (app)
  - /nginx-healthz (edge Nginx)
- DynamoDB usage (backend/dynamo.js): same behavior as before (on‑demand, tables prefixed by DDB_TABLE_PREFIX, region DDB_REGION/AWS_REGION/AWS_DEFAULT_REGION).

Frontend application details
- Offline‑first PWA.
- Runtime backend URL: frontend/website/config.js should point to http://api.<DomainName> by default (or set window.RUNTIME_CONFIG.BACKEND_URL at runtime).

AWS infrastructure (what gets created and how it’s wired)

Backend stack (infrastructure/backend/template.yaml)
- IAM: Instance role/profile with AmazonSSMManagedInstanceCore.
- Security Group: Inbound 80/443/22 from 0.0.0.0/0 (adjust as needed); outbound open.
- EC2 Instance: Amazon Linux 2, installs Docker + docker-compose in user data, clones this repo, and starts docker‑compose from the repo root (bringing up edge Nginx, frontend, backend).
- Elastic IP: Allocated and associated with the instance.
- Route 53 records (conditional via CreateApiDnsRecord):
  - Route 53 records:
  - A record for api.<DomainName> → EIP
  - A record for <DomainName> (apex) → EIP
- User data bootstrapping highlights:
  - Writes /opt/app/.env with CORS_ORIGIN=http://<DomainName>,https://<DomainName> and DOMAIN_NAME=<DomainName>.
  - Runs docker‑compose up -d from the repository root.

Runtime configuration and environment variables
- docker-compose.yml:
  - backend service env:
    - PORT=8080, HTTPS_PORT=8443 (dev), REDIRECT_HTTP_TO_HTTPS=false
    - CORS_ORIGIN: Comma‑separated allowed origins; defaults include http://<DomainName>,https://<DomainName>
    - JWT_SECRET, WEB_PUSH_PUBLIC_KEY/WEB_PUSH_PRIVATE_KEY
    - DDB_REGION / AWS_REGION / AWS_DEFAULT_REGION
  - logging: All containers use awslogs driver with region and log groups derived from DOMAIN_NAME.
- nginx.conf: Two server blocks for HTTP 80 with server_name api.<DomainName> (backend) and <DomainName> (frontend); both also accept their www variants (www.api.<DomainName> and www.<DomainName>). HTTPS blocks can be added once certs are present in /etc/letsencrypt.

TLS considerations
- HTTPS can be enabled on the instance using Certbot (Let’s Encrypt) with the provided ACME webroot. By default the stack runs HTTP only to minimize cost and complexity.

Deploying and updating
- Update deploy/constants.yaml with your values (DomainName, HostedZoneId, Region, etc.). The stack now creates its own minimal VPC and a public subnet automatically.
- Deploy/update the stack with .github/workflows/deploy.yml (or via AWS Console/CLI) to provision/update the VPC, subnet, EC2, EIP, Security Groups, and Route53 records.
- Redeploy code: re-run the deploy workflow; the instance will git pull and restart the Docker stack as needed.

Operations
- Health checks:
  - Edge Nginx: http://api.<DomainName>/nginx-healthz
  - API: http://api.<DomainName>/healthz
  - Frontend: http://<DomainName>/
- Diagnostics script:
  - ./scripts/check-backend.sh <DomainName> (defaults API_SUB=api)
- Logs:
  - CloudWatch Logs: /TickTock/Edge-<DOMAIN>, /TickTock/FrontendSite-<DOMAIN>, /TickTock/Backend-<DOMAIN>
- DynamoDB: Tables created lazily by the backend on first access.

Security notes and best practices
- Lock down SSH (or use SSM Session Manager); restrict SG ingress.
- Use strong JWT_SECRET; store secrets in SSM/Secrets Manager.
- Consider adding a load balancer + TLS termination and auto‑scaling later if you need HA.

Troubleshooting
- Frontend loads but API calls fail (CORS): ensure CORS_ORIGIN includes http(s)://<DomainName>.
- api.<DomainName> DNS resolves but /healthz fails: check edge Nginx container and backend container health; verify docker compose ps and logs.
- 404s for apex host: confirm nginx.conf server_name for <DomainName> and that ttt-frontend is running.

Appendix: Key files
- docker-compose.yml — defines backend, frontend, edge Nginx containers
- nginx.conf — host‑based routing to backend/frontend containers
- backend/Dockerfile — Node backend build
- deploy/constants.yaml — central non-secret deployment constants (Hosted Zone ID, VPC, Subnets, Domain)
- deploy/cfn/stack.yaml — CloudFormation stack (EC2, EIP, Security Groups, Route53 records)
- .github/workflows/deploy.yml — CI workflow that reads constants and deploys/updates the stack

License
- MIT (see LICENSE).
