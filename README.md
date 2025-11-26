# TickTock Tasks — Deployment and Operations Guide (EC2 two‑container)

High‑level summary
- Frontend: Static PWA served from a dedicated Docker container (nginx) on the same EC2 instance as the backend. Public host: http://www.<DomainName> (or with TLS if enabled at Nginx).
- API backend: Node.js/Express app in a Docker container on the same EC2 instance. Public host: http://www.api.<DomainName>.
- Reverse proxy: An edge Nginx container listens on ports 80/443 on the EC2 host and routes requests by Host header to either the frontend container (www) or the backend container (www.api). Certbot volumes are present to enable optional TLS.
- Data store: Amazon DynamoDB (on‑demand) tables created/used directly by the backend.
- Logging/observability: Containers ship logs to Amazon CloudWatch Logs using the awslogs Docker logging driver; health endpoints and a diagnostics script are provided.

Repository map (deployment‑relevant)
- docker-compose.yml — Defines three containers on EC2: backend, frontend (static site), and edge Nginx (reverse proxy), plus Certbot volumes.
- nginx.conf — Reverse proxy config for host‑based routing (www → frontend, www.api → backend) and ACME challenges.
- backend/ — Backend Dockerfile, Node app, DynamoDB access layer, TLS dev entrypoint.
- frontend/website/ — Static PWA site (index.html, app.js, manifest.json, service worker, etc.).
- deploy/cfn/stack.yaml — New CloudFormation template that provisions ACM, ALB (HTTPS), EC2, Security Groups, and Route 53 alias records for www.api.<DomainName> and www.<DomainName>.
- scripts/check-backend.sh — External connectivity diagnostics for the new hostnames.

Architecture overview

Request flow
1) End user visits http://www.<DomainName> (or https://www.<DomainName> if you enable TLS on the instance).
   - Route 53 points the www A record to the EC2 Elastic IP.
   - The edge Nginx receives the request and proxies to the frontend container.
2) Frontend calls the API at http://www.api.<DomainName> (default configured in frontend/website/config.js; can be overridden at deploy time).
   - Route 53 points www.api A record to the same EC2 Elastic IP.
   - The edge Nginx receives the request and proxies to the backend container.

Containers on the EC2 host
- nginx (edge, image: nginx:alpine)
  - Listens on host ports 80 and 443 (HTTPS server blocks are not included by default; Certbot volumes are available to enable TLS later).
  - Routes by Host header:
    - www.<DomainName> → frontend container
    - www.api.<DomainName> → backend container
  - ACME challenges served from /var/www/certbot.
  - Health endpoint: /nginx-healthz → 200 ok.
  - Logs to CloudWatch Logs group /TickTock/Edge-<DOMAIN> via awslogs driver.

- frontend (image: nginx:alpine)
  - Serves the static site from ./frontend/website mounted read‑only at /usr/share/nginx/html.
  - No host ports exposed; only accessible through the edge Nginx by Host routing.
  - Logs to CloudWatch Logs group /TickTock/FrontendSite-<DOMAIN> via awslogs driver.

- backend (built from backend/Dockerfile)
  - Node.js/Express app (index.js), HTTP on 8080, optional self‑signed HTTPS on 8443 for dev.
  - CORS_ORIGIN defaults to http(s)://www.<DomainName>.
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
- Runtime backend URL: frontend/website/config.js now defaults to http://www.api.<DomainName>. You can override this via CI or a prebuilt config if you use another domain.

AWS infrastructure (what gets created and how it’s wired)

Backend stack (infrastructure/backend/template.yaml)
- IAM: Instance role/profile with AmazonSSMManagedInstanceCore.
- Security Group: Inbound 80/443/22 from 0.0.0.0/0 (adjust as needed); outbound open.
- EC2 Instance: Amazon Linux 2, installs Docker + docker-compose in user data, clones this repo, and starts docker‑compose from the repo root (bringing up edge Nginx, frontend, backend).
- Elastic IP: Allocated and associated with the instance.
- Route 53 records (conditional via CreateApiDnsRecord):
  - A record for www.api.<DomainName> → EIP
  - A record for www.<DomainName> → EIP
- User data bootstrapping highlights:
  - Writes /opt/app/.env with CORS_ORIGIN=http://www.<DomainName>,https://www.<DomainName> and DOMAIN_NAME=<DomainName>.
  - Runs docker‑compose up -d from the repository root.

Runtime configuration and environment variables
- docker-compose.yml:
  - backend service env:
    - PORT=8080, HTTPS_PORT=8443 (dev), REDIRECT_HTTP_TO_HTTPS=false
    - CORS_ORIGIN: Comma‑separated allowed origins; defaults include http://www.<DomainName>,https://www.<DomainName>
    - JWT_SECRET, WEB_PUSH_PUBLIC_KEY/WEB_PUSH_PRIVATE_KEY
    - DDB_REGION / AWS_REGION / AWS_DEFAULT_REGION
  - logging: All containers use awslogs driver with region and log groups derived from DOMAIN_NAME.
- nginx.conf: Two server blocks for HTTP 80 with server_name www.api.<DomainName> (backend) and www.<DomainName> (frontend). HTTPS blocks can be added once certs are present in /etc/letsencrypt.

TLS considerations
- HTTPS is terminated at the AWS Application Load Balancer using an ACM certificate provisioned by deploy/cfn/stack.yaml. The instance serves HTTP only; no Certbot is required.

Deploying and updating
- Update deploy/constants.yaml with your values (DomainName, HostedZoneId, VpcId, PublicSubnetIds, etc.).
- Deploy/update the stack with .github/workflows/deploy.yml (or via AWS Console/CLI) to provision/update ACM, ALB, EC2, and DNS records.
- Redeploy code: re-run the deploy workflow; the instance will git pull and restart the Docker stack as needed.

Operations
- Health checks:
  - Edge Nginx: http://www.api.<DomainName>/nginx-healthz
  - API: http://www.api.<DomainName>/healthz
  - Frontend: http://www.<DomainName>/
- Diagnostics script:
  - ./scripts/check-backend.sh <DomainName> (defaults API_SUB=www.api)
- Logs:
  - CloudWatch Logs: /TickTock/Edge-<DOMAIN>, /TickTock/FrontendSite-<DOMAIN>, /TickTock/Backend-<DOMAIN>
- DynamoDB: Tables created lazily by the backend on first access.

Security notes and best practices
- Lock down SSH (or use SSM Session Manager); restrict SG ingress.
- Use strong JWT_SECRET; store secrets in SSM/Secrets Manager.
- Consider ALB/NLB + TLS termination and auto‑scaling if you need HA.

Troubleshooting
- Frontend loads but API calls fail (CORS): ensure CORS_ORIGIN includes http(s)://www.<DomainName>.
- www.api DNS resolves but /healthz fails: check edge Nginx container and backend container health; verify docker compose ps and logs.
- 404s for www host: confirm nginx.conf server_name for www.<DomainName> and that ttt-frontend is running.

Appendix: Key files
- docker-compose.yml — defines backend, frontend, edge Nginx containers
- nginx.conf — host‑based routing to backend/frontend containers
- backend/Dockerfile — Node backend build
- deploy/constants.yaml — central non-secret deployment constants (Hosted Zone ID, VPC, Subnets, Domain)
- deploy/cfn/stack.yaml — CloudFormation stack (ACM cert, ALB HTTPS, EC2, Route53 records)
- .github/workflows/deploy.yml — CI workflow that reads constants and deploys/updates the stack

License
- MIT (see LICENSE).
