2025-10-03

Change summary:
- Removed CloudFront/S3 from the serving path. Frontend is now served by Nginx on the same EC2 instance as the backend.
- Updated nginx.conf to serve SPA from ./frontend/website and proxy /api/* to backend.
- docker-compose now mounts frontend/website into Nginx container.
- Added frontend/website/config.js setting BACKEND_URL='' (same-origin).
- Marked infra/frontend/template.yaml as DEPRECATED (no longer used).
- Updated README with new architecture and deployment steps.
- Expanded service worker pre-cache to include core assets (styles.css, app.js, app-version.js, icons, manifests) so the app renders with proper formatting offline.

Operator notes:
- Point DNS directly at the EC2 instance (or an Elastic IP). No CloudFront distribution is needed.
- Set backend CORS_ORIGIN to your site origin(s) in .env before starting containers.
- For TLS, use Certbot or your preferred method on the instance; mount certs into the nginx container if terminating TLS there.
