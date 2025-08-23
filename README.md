# TickTock Tasks

A smart, recurring to-do app with reminders. Works offline (PWA) and can sync via an optional Dockerized backend. This README focuses on the minimal, step‑by‑step setup you asked for.

## 1) Frontend (PWA)
Prerequisites: Any static file server.

Steps:
1. In this folder, start a simple server on your LAN (example):
   - python3 -m http.server 8000
   - Open http://192.168.1.6:8000 on your device(s).
2. In the app header, click "Enable Notifications" to allow reminders.
3. Create a task, choose how often it repeats, set next due date and time, then Save.
4. Optional: Click "Install App" to add to home screen for an app-like, offline experience.

Notes:
- Without the backend, your data stays in the browser’s local storage on the device.
- You can set a backend later with the "Set Backend" button in the header.

## 2) Backend (Docker)
Single command startup:
- bash backend-up.sh http://192.168.1.6:8000
  - First run on macOS/Linux may require: chmod +x backend-up.sh

What the script does:
- Creates/updates .env with CORS_ORIGIN, a secure JWT secret, and Web Push VAPID keys (if npx is available).
- Starts the backend with Docker Compose. HTTP 8080 redirects to HTTPS 8443.

Connect the frontend to the backend (now HTTPS):
- In the app header, click "Set Backend" and enter: https://192.168.1.6:8443
  - This stores the URL in localStorage and reloads the app.
  - Alternatively (console): localStorage.setItem('tt_backend_url','https://192.168.1.6:8443')
- Because we use a self‑signed development certificate, your browser will warn the first time. Visit https://192.168.1.6:8443 once and accept the warning, then the app can talk to it.
- Sign up (email/password) in the header, then use the app. Tasks will sync across devices using the same account.

Optional configuration:
- To manually set VAPID keys, run: npx web-push generate-vapid-keys and put the values in .env as WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY (backend-up.sh can auto-generate if npx is available).

## 3) Mobile App (React Native / Expo)
You can now run a native mobile app that talks to the AWS serverless backend.

Prerequisites:
- Node.js 18+ and npm
- Expo CLI (installed automatically via npm scripts)
- iOS: Xcode (for simulator) or Expo Go app; Android: Android Studio (emulator) or Expo Go app

Steps:
1. Deploy the backend to AWS first (see section 4) and copy the API URL from outputs (looks like https://abc123.execute-api.us-east-1.amazonaws.com).
2. Start the mobile app:
   - cd mobile
   - npm install
   - npm run start
3. Open on your phone with Expo (scan the QR) or run in emulator (press i for iOS simulator, a for Android emulator).
4. In the app, paste the Backend URL you copied in step 1.
5. Register/Login and start creating tasks.

Notes:
- The app uses Authorization: Bearer tokens (no cookies), so it works cleanly with API Gateway across devices.

## 4) Backend (AWS Serverless + GitHub Actions)
A new serverless backend is included under serverless/ using AWS SAM, API Gateway (HTTP API), Lambda (Node.js 20), and DynamoDB.

What you get:
- Endpoints: /api/auth/register, /api/auth/login, /api/auth/me, /api/tasks (GET/POST), /api/tasks/:id (PUT/DELETE), /healthz
- Auth: JWT in Authorization header; token returned on login/register
- Storage: DynamoDB (Users table keyed by email; Tasks table keyed by userId + id)
- CORS: Enabled for all origins by default; you can restrict in template.yaml
- CI/CD: .github/workflows/deploy-serverless.yml deploys on push to main

One-time AWS setup:
1. Create an AWS IAM Role for GitHub OIDC (recommended). In IAM, set a trust policy for token.actions.githubusercontent.com and allow CloudFormation, Lambda, DynamoDB, S3 (for SAM packaging), and IAM pass-role rights as needed.
2. In your GitHub repo settings:
   - Secrets: set AWS_ROLE_TO_ASSUME to the role ARN you created.
   - Secrets: set JWT_SECRET to a strong random string.
   - Variables (optional): set AWS_REGION (e.g., us-east-1) and STACK_NAME (default: tictock-serverless).

Deploy via GitHub Actions:
- Push to main with changes under serverless/ and the workflow will:
  - Build and deploy the SAM stack.
  - Output the API URL in the job logs.

Deploy from local (optional):
- Install AWS SAM CLI and AWS credentials.
- cd serverless && npm install
- sam build --use-container
- sam deploy --guided
  - Provide a stack name, region, and parameter JwtSecret

Connecting the mobile app:
- Use the API URL from stack outputs (format: https://<id>.execute-api.<region>.amazonaws.com) as the Backend URL inside the mobile app.

Security/Production notes:
- Rotate JWT_SECRET and protect it as a secret.
- Consider custom domains + ACM cert for API Gateway if you want a pretty URL.
- Web Push endpoints were not moved to serverless in this pass; the mobile app does not require Web Push.

## 5) Android App (Trusted Web Activity)
Use the provided one‑shot script. Serve your site over HTTPS first.

Prerequisites:
- Node.js (for npx) or a global `bubblewrap` CLI
- Java JDK and Android SDK/Studio
- Your app must be reachable over HTTPS (production requirement for TWA and Web Push)

Build in one command (HTTPS recommended):
- bash twa-build.sh https://192.168.1.6
  - Optional directory: --dir my-twa
  - Verbose logs: DEBUG=bubblewrap:* bash twa-build.sh https://192.168.1.6

Dev-only init from HTTP (if you’re serving with python on 8000):
- bash twa-build.sh http://192.168.1.6:8000 --allow-insecure
  - You can also point directly to a manifest: --manifest http://192.168.1.6:8000/manifest.json
  - The build script downloads the manifest to a local file before calling Bubblewrap to avoid ENOENT errors when some CLIs mis-handle HTTP URLs.
  - Note: Final TWA should target a trusted HTTPS origin before release/testing on Android.

What the script does:
- Verifies the Web Manifest is reachable at /manifest.webmanifest, falling back to /manifest.json.
- Allows HTTP manifest when --allow-insecure is used (development only).
- Runs bubblewrap init (first run) then bubblewrap build.
- Prints paths to the generated APK/AAB.

Install on device:
- Sideload the APK on Android (enable "install from unknown sources").
- For Play Store, use the AAB and follow Play Console requirements.

Tip: If build fails to fetch the manifest, ensure your site is HTTPS and that either /manifest.webmanifest or /manifest.json is accessible. Icons in the manifest should be PNG (192x192 and 512x512).

Android signing troubleshooting (apksigner / keystore errors):
- Symptom: apksigner sign fails with "Failed to load signer" or "Wrong password?" when trying to sign using twa/android.keystore.
- Fast remedies:
  1) Use the build script’s signing fallback with your own keystore:
     - bash twa-build.sh https://192.168.1.6 --ks /path/to/your.keystore --ks-alias yourAlias --ks-pass yourStorePass --key-pass yourKeyPass
  2) Or let the script auto-generate and use a debug keystore if Bubblewrap didn’t produce a signed APK:
     - bash twa-build.sh https://192.168.1.6
     - If a signed APK is missing but an unsigned-aligned APK exists, the script creates android-debug.keystore and signs the APK for you.
  3) If you want Bubblewrap to recreate its keystore interactively:
     - Remove the existing TWA keystore and re-run init/update in the twa directory:
       - rm -f twa/android.keystore
       - (cd twa && npx @bubblewrap/cli update --manifest=https://192.168.1.6/manifest.webmanifest)
     - When prompted, provide new passwords and note them for future builds.

Note about HTTPS backend certificate:
- This repo auto-generates a self-signed dev certificate inside the backend container for localhost and 192.168.1.6. If your laptop has a different IP, set CERT_HOSTS in docker-compose.yml or environment (comma-separated), then rerun backend-up.sh to regenerate the cert.
- Your browser will need to trust/accept the self-signed certificate the first time you visit https://192.168.1.6:8443.

Android and self-signed certificates (important):
- Chrome on Android (and thus TWA) will not trust self-signed certificates. As a result, the Android app cannot call your backend if it’s using the auto-generated self-signed cert.
- You have two options:
  A) Recommended – use a trusted HTTPS certificate
    - Provide your own trusted cert/key to the backend by mounting files and pointing env vars to them (via docker-compose.yml or environment):
      - HTTPS_CERT_PATH=/certs/your-cert.pem
      - HTTPS_KEY_PATH=/certs/your-key.pem
      - Then mount your certs folder into the container (e.g., add a volume: - ./certs:/certs:ro) and rerun backend-up.sh
    - Or place the backend behind a reverse proxy or a tunnel that terminates TLS with a valid cert (e.g., Caddy/Nginx with a public DNS name, Cloudflare Tunnel, or ngrok). Point the frontend to that HTTPS origin.
  B) Dev fallback – run over HTTP (no TLS) on your LAN
    - This is only for local development and testing. Serve both frontend and backend over HTTP to avoid TLS issues:
      1. Disable the backend redirect by setting REDIRECT_HTTP_TO_HTTPS=false (docker-compose already supports this env):
         - REDIRECT_HTTP_TO_HTTPS=false docker compose up --build -d
      2. Serve the frontend over HTTP (e.g., python3 -m http.server 8000) and set the backend URL to http://192.168.1.6:8080 in the app.
      3. Do NOT use this mode with the TWA/Play Store. Before building the Android app, switch to a trusted HTTPS origin as in option A.

## About the App (what you get)
- Recurring tasks: daily, weekly, monthly (approx), or custom every N days
- Reminders at a chosen time; missed reminders move to the next day and mark PRIORITY
- Works offline (PWA); optional Docker backend adds accounts and syncing
- Clean, simple UI – installable to home screen

Tech summary:
- Frontend: Vanilla HTML/CSS/JS with Service Worker + Web Manifest
- Backend (optional): Node.js/Express + SQLite (Dockerized), JWT auth, Web Push

Security notes (brief):
- Auth cookies are HttpOnly SameSite=Lax; passwords are bcrypt‑hashed
- CORS restricted to the configured frontend origin; Helmet and rate limits enabled

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE).
