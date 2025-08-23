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
- Node.js 20.x LTS and npm (use nvm; this repo includes an .nvmrc)
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
- If npm start fails due to Node.js version (e.g., v23+), switch to Node.js 20 LTS:
  - nvm install 20
  - nvm use 20
  - or simply run nvm use in this repo (we include an .nvmrc)
- If you see npm warn EBADENGINE Unsupported engine during npm install, your local Node version isn’t 20.x. Installs will still proceed (engine-strict=false), but for compatibility please use: nvm use 20
- If you see “PlatformConstants could not be found” or “TurboModuleRegistry invariant violation” after scanning the QR in Expo Go:
  - Update Expo Go to the latest version from the App Store/Play Store (must match SDK 53).
  - Clear the bundler cache: npx expo start -c
  - Ensure the project installs dependencies inside mobile/ and uses the provided metro.config.js (which fixes monorepo module resolution).
- If you see “Cannot find module 'metro/src/lib/TerminalReporter'” or “Cannot find module 'metro/src/ModuleGraph/worker/importLocationsPlugin'” when starting Expo:
  - We pin Metro to a compatible version (0.83.x) at the repo root (overrides) and inside mobile to avoid hoisting mismatches.
  - Clean install in this order:
    1) rm -rf node_modules && npm install
    2) rm -rf mobile/node_modules && (cd mobile && npm install)
  - Then start with a clean cache: (cd mobile && npx expo start -c)
  - If you still hit errors, also clear the Expo cache directory and try again: rm -rf ~/.expo && (cd mobile && npx expo start -c)

### Alternative: Installable Android app without Expo (TWA)
If you want an installable app on Android quickly — without Metro/Expo — package the PWA as a native Android APK/AAB using the included Bubblewrap script.

Requirements:
- Java JDK + Android SDK (Bubblewrap will prompt/verify)
- Node.js (for npx) or a global @bubblewrap/cli
- Your site served over HTTPS in production; HTTP can be used on LAN for dev with a flag

Steps (dev on your LAN):
1) Serve this repo root on your LAN, e.g.:
   - python3 -m http.server 8000
   - Note your LAN IP, e.g., http://192.168.1.6:8000
2) Build the Android app using Bubblewrap via our helper:
   - bash twa-build.sh http://192.168.1.6:8000 --allow-insecure
   - Note: The script downloads your manifest and ensures iconUrl is an absolute URL (required by Bubblewrap). This avoids the common error: "cli ERROR Invalid URL: /icons/icon-512.png".
3) When it finishes, look under ./twa for outputs. The script prints the paths, typically:
   - APK: twa/app-release-signed.apk (sideload this on your device)
   - AAB: twa/*.aab (for Play Play Console)
   - If you previously attempted a build and see JSON errors, remove the existing TWA project and retry:
     rm -rf twa && bash twa-build.sh http://192.168.1.6:8000 --allow-insecure
4) Sideload the APK:
   - Option A: adb install ./twa/app-release-signed.apk
   - Option B: Transfer the APK to your phone (Drive/AirDrop/etc.) and install (enable Unknown Sources).
5) Open the installed app, tap the header’s “Set Backend”, and enter the AWS API URL:
   - https://09h6cvwjjd.execute-api.us-east-1.amazonaws.com
   This is saved on the device and used for all API calls (e.g., /api/auth/login, /api/tasks).

Steps (production HTTPS origin):
- bash twa-build.sh https://your-domain.example
- After installing the APK, set the Backend URL to your AWS API Gateway endpoint:
  https://09h6cvwjjd.execute-api.us-east-1.amazonaws.com

Tips:
- Provide a custom manifest: --manifest https://host/manifest.json
- For production signing, pass keystore flags: --ks FILE --ks-alias ALIAS --ks-pass PASS --key-pass PASS
  - You can also set env vars instead of flags: TWA_KS, TWA_KS_ALIAS, TWA_KS_PASS, TWA_KEY_PASS
  - If signing with your keystore fails (wrong password/alias), the script will WARN and automatically fall back to a debug keystore so you still get a signed APK for sideloading.
- Quick API health check (from your phone’s browser or with curl):
  https://09h6cvwjjd.execute-api.us-east-1.amazonaws.com/healthz

iOS alternatives:
- Add to Home Screen: open your deployed HTTPS site in Safari, tap Share → Add to Home Screen (full‑screen PWA experience).
- Native RN build: If you want a native binary later, we can add Expo Application Services (EAS) for .ipa/.apk builds. This needs an Expo account and Apple certs for iOS.

## 4) Backend (AWS Serverless + GitHub Actions)
A new serverless backend is included under serverless/ using AWS SAM, API Gateway (HTTP API), Lambda (Node.js 20), and DynamoDB.

## 5) Frontend Deployment (AWS S3 + CloudFront + ACM + Route53)
Host the PWA at https://ticktocktasks.com (and https://www.ticktocktasks.com) using an S3 bucket behind CloudFront with an ACM certificate.

What you get:
- Private S3 bucket for site content (accessed only by CloudFront Origin Access Control).
- ACM certificate (us-east-1) for ticktocktasks.com and www.ticktocktasks.com with DNS validation.
- CloudFront distribution with custom domain aliases, compression, HTTPS-only, and SPA routing (404/403 -> /index.html).
- Route53 A/AAAA alias records for apex and www.
- GitHub Actions that deploy infra, upload site files, and invalidate CloudFront on every push to main affecting web assets.

One-time AWS setup:
1) Ensure a public Route53 hosted zone exists for ticktocktasks.com in your AWS account.
2) In your GitHub repo settings:
   - Secrets: set AWS_ROLE_TO_ASSUME to the IAM Role ARN used for deployments (OIDC trust, same as backend).
   - Variables: HOSTED_ZONE_ID is optional; the workflow defaults to Z08471201NA2PN7ERBIB7 (Route53 Hosted Zone ID for ticktocktasks.com). Set it only if you need to override.

Deploy via GitHub Actions:
- Push to main changing any of: index.html, app.js, styles.css, sw.js, icons/, manifest.json, manifest.webmanifest.
- The workflow .github/workflows/deploy-frontend.yml will:
  - Deploy the CloudFormation stack (us-east-1) found at infra/frontend/template.yaml.
  - Sync the site to S3 with long-cache headers for static assets and no-cache for index.html and sw.js.
  - Invalidate CloudFront (paths: /*).
- First run will create/validate the ACM certificate automatically via DNS records in your hosted zone.

Manual run (optional):
- You can also run the steps locally if you have AWS CLI access:
  - aws cloudformation deploy --stack-name tictock-frontend --template-file infra/frontend/template.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-1 --parameter-overrides DomainName=ticktocktasks.com IncludeWww=true HostedZoneId=YOUR_ZONE_ID
  - Retrieve outputs: aws cloudformation describe-stacks --stack-name tictock-frontend --region us-east-1
  - Sync content: aws s3 sync . s3://<BucketName>/ (apply cache headers as in the workflow)
  - Invalidate: aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'

Notes:
- The backend CORS is permissive by default; you may later restrict to https://ticktocktasks.com from serverless/template.yaml if desired.
- CloudFront cache policy uses AWS Managed-CachingOptimized; index.html/sw.js are uploaded with no-cache to ensure fresh app shell.

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
