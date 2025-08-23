#!/usr/bin/env bash
set -euo pipefail

# TickTock Tasks – One-shot Bubblewrap init+build
# Usage:
#   bash twa-build.sh ORIGIN [--dir twa] [--manifest URL] [--allow-insecure] [--ks FILE --ks-alias ALIAS --ks-pass PASS --key-pass PASS]
# Examples:
#   bash twa-build.sh https://example.com
#   bash twa-build.sh http://192.168.1.6:8000 --allow-insecure
#   DEBUG=bubblewrap:* bash twa-build.sh https://my-host:8443 --dir my-twa
#   # With custom keystore for signing fallback:
#   bash twa-build.sh https://example.com --ks my.keystore --ks-alias myalias --ks-pass secret --key-pass secret
#
# Requirements:
#   - Node.js (for npx) OR a globally installed `bubblewrap` CLI
#   - Java JDK & Android SDK (Bubblewrap will guide/verify)
#   - For production TWA, your app must be served over HTTPS
#
# Behavior:
#   - Checks reachability of /manifest.webmanifest; falls back to /manifest.json
#   - With --allow-insecure, HTTP origins are allowed for init in development
#   - Accepts an explicit --manifest URL override
#   - Runs `bubblewrap init` in a subdirectory (default: ./twa)
#   - Then runs `bubblewrap build` to produce APK/AAB
#   - If Bubblewrap-produced signed APK is missing but an unsigned-aligned APK exists, this script signs it
#     - Uses provided keystore (if flags given), or generates a debug keystore automatically
#   - Prints paths to the generated files

if [ $# -lt 1 ]; then
  echo "Usage: bash $0 ORIGIN [--dir DIR] [--manifest URL] [--allow-insecure] [--ks FILE --ks-alias ALIAS --ks-pass PASS --key-pass PASS]" >&2
  exit 1
fi

ORIGIN="$1"; shift || true
TARGET_DIR="twa"
EXPLICIT_MANIFEST=""
ALLOW_INSECURE=false
# Optional signing params
KS_FILE=""
KS_ALIAS=""
KS_PASS=""
KEY_PASS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      TARGET_DIR="$2"; shift 2;;
    --manifest)
      EXPLICIT_MANIFEST="$2"; shift 2;;
    --allow-insecure)
      ALLOW_INSECURE=true; shift;;
    --ks)
      KS_FILE="$2"; shift 2;;
    --ks-alias)
      KS_ALIAS="$2"; shift 2;;
    --ks-pass)
      KS_PASS="$2"; shift 2;;
    --key-pass)
      KEY_PASS="$2"; shift 2;;
    *)
      echo "Unknown argument: $1" >&2; exit 1;;
  esac
done

# Enforce HTTPS unless explicitly allowed for development
if [[ "$ORIGIN" != https://* ]] && [ "$ALLOW_INSECURE" != true ]; then
  echo "Error: Origin must be HTTPS. Given: $ORIGIN" >&2
  echo "Hint: Serve this folder over HTTPS (reverse proxy or mkcert) and try again." >&2
  echo "Dev-only: pass --allow-insecure to allow HTTP during init (e.g., http://192.168.1.6:8000)." >&2
  exit 2
fi

# Helper to choose bubblewrap command (prefer npx)
if command -v npx >/dev/null 2>&1; then
  BW_CMD=(npx --yes @bubblewrap/cli)
elif command -v bubblewrap >/dev/null 2>&1; then
  BW_CMD=(bubblewrap)
else
  echo "Error: Could not find 'npx' or 'bubblewrap' CLI. Install Node.js or @bubblewrap/cli." >&2
  exit 3
fi

# Suppress Node deprecation warnings (e.g., DEP0040 punycode) during CLI runs
export NODE_OPTIONS="--no-deprecation ${NODE_OPTIONS:-}"

# Resolve manifest URL
pick_manifest_url() {
  local base="$1" # includes scheme and host[:port]
  local try_https_first="$2" # true/false
  local status url

  if [ -n "$EXPLICIT_MANIFEST" ]; then
    # Trust explicit manifest; just return it
    echo "$EXPLICIT_MANIFEST"
    return 0
  fi

  # Try .webmanifest then .json on given base
  url="$base/manifest.webmanifest"
  status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$url" || true)
  if [ "$status" = "200" ]; then echo "$url"; return 0; fi
  url="$base/manifest.json"
  status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$url" || true)
  if [ "$status" = "200" ]; then echo "$url"; return 0; fi

  echo "" # no luck
}

MANIFEST_URL=""

# Primary attempt: use the origin as provided
MANIFEST_URL=$(pick_manifest_url "$ORIGIN" true)

if [ -z "$MANIFEST_URL" ]; then
  # If origin was HTTPS and unreachable, and insecure allowed, try common HTTP dev ports
  if [[ "$ORIGIN" == https://* ]] && [ "$ALLOW_INSECURE" = true ]; then
    host_port=${ORIGIN#https://}
    host=${host_port%%/*}
    for p in 8000 8080 3000; do
      candidate="http://$host:$p"
      cand_url=$(pick_manifest_url "$candidate" false)
      if [ -n "$cand_url" ]; then
        MANIFEST_URL="$cand_url"
        echo "Warning: Using HTTP manifest for init (development). Candidate base: $candidate" >&2
        break
      fi
    done
  fi
fi

if [ -z "$MANIFEST_URL" ]; then
  # Final error with actionable hints
  echo "Error: Could not reach manifest at either HTTPS or allowed fallbacks." >&2
  echo "Tried: $ORIGIN/manifest.webmanifest and /manifest.json" >&2
  if [[ "$ORIGIN" == https://* ]]; then
    echo "Tips:" >&2
    echo " - Ensure your site is actually served over HTTPS at $ORIGIN" >&2
    echo " - Or for development, try: bash $0 http://<YOUR-LAN-IP>:8000 --allow-insecure" >&2
    echo " - Or provide a direct manifest URL: --manifest https://host/manifest.json" >&2
  else
    echo "Tips:" >&2
    echo " - Serve over HTTPS for production TWA, or pass --allow-insecure for dev." >&2
  fi
  exit 4
fi

# If we found an HTTP manifest without --allow-insecure, fail safe (should not happen)
if [[ "$MANIFEST_URL" == http://* ]] && [ "$ALLOW_INSECURE" != true ]; then
  echo "Error: Resolved manifest is HTTP: $MANIFEST_URL. Re-run with --allow-insecure for development." >&2
  exit 5
fi

echo "Using manifest: $MANIFEST_URL"

# Create/enter target directory
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

# Download manifest locally to avoid ENOENT when some CLIs mis-handle URLs
EXT="${MANIFEST_URL##*.}"
case "$EXT" in
  webmanifest|json) : ;;
  *) EXT="webmanifest";;
esac
LOCAL_MANIFEST="./resolved-manifest.$EXT"
echo "Fetching manifest to local file: $LOCAL_MANIFEST"
if ! curl -sSL --fail --max-time 15 -o "$LOCAL_MANIFEST" "$MANIFEST_URL"; then
  echo "Error: Failed to download manifest from $MANIFEST_URL" >&2
  exit 7
fi

# Inject a top-level iconUrl with an absolute URL (Bubblewrap expects it when reading local files)
# Compute base origin (scheme://host[:port]) from MANIFEST_URL
ORIGIN_FROM_MANIFEST=$(printf '%s' "$MANIFEST_URL" | sed -E 's#^(https?://[^/]+).*$#\1#')
ICON_URL_DEFAULT="$ORIGIN_FROM_MANIFEST/icons/icon-512.png"
if ! grep -q '"iconUrl"' "$LOCAL_MANIFEST" >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    tmpfile=$(mktemp)
    jq --arg icon "$ICON_URL_DEFAULT" '.iconUrl = $icon' "$LOCAL_MANIFEST" > "$tmpfile" && mv "$tmpfile" "$LOCAL_MANIFEST"
  else
    # sed fallback: insert as the first field after the opening brace
    # This keeps JSON valid by adding a trailing comma after iconUrl
    sed -i.bak '0,/{/s//{ "iconUrl": "'"$ICON_URL_DEFAULT"'",/' "$LOCAL_MANIFEST" && rm -f "$LOCAL_MANIFEST.bak"
  fi
fi

# If already initialized, skip init and update instead
if [ -f "twa-manifest.json" ] || [ -f "android/gradlew" ]; then
  echo "Existing Bubblewrap project detected in $(pwd). Running 'bubblewrap update'..."
  "${BW_CMD[@]}" update --manifest="$LOCAL_MANIFEST"
else
  echo "Initializing Bubblewrap project in $(pwd)..."
  # Note: bubblewrap init may still prompt for details (packageId, names, keystore).
  # This script ensures the manifest is reachable and prevents the common hangs.
  "${BW_CMD[@]}" init --manifest="$LOCAL_MANIFEST"
fi

# Build APK/AAB
echo "Building APK/AAB..."
set +e
"${BW_CMD[@]}" build
BW_STATUS=$?
set -e

# Try to locate build outputs
APK_PATH=$(find . -type f -name "*.apk" | head -n 1 || true)
AAB_PATH=$(find . -type f -name "*.aab" | head -n 1 || true)
UNSIGNED_APK=$(find . -type f -name "*unsigned-aligned.apk" | head -n 1 || true)

# If no signed APK produced but unsigned exists, try to sign it
if [ -z "$APK_PATH" ] && [ -n "$UNSIGNED_APK" ]; then
  echo "No signed APK detected, but found unsigned aligned APK: $UNSIGNED_APK" >&2
  echo "Attempting to sign the APK..." >&2

  # Locate apksigner
  if ! command -v apksigner >/dev/null 2>&1; then
    # Try common SDK locations
    if [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -f "$ANDROID_SDK_ROOT/build-tools/$(ls -1 $ANDROID_SDK_ROOT/build-tools | sort -V | tail -n1)/apksigner" ]; then
      export PATH="$ANDROID_SDK_ROOT/build-tools/$(ls -1 $ANDROID_SDK_ROOT/build-tools | sort -V | tail -n1):$PATH"
    elif [ -n "${ANDROID_HOME:-}" ] && [ -f "$ANDROID_HOME/build-tools/$(ls -1 $ANDROID_HOME/build-tools | sort -V | tail -n1)/apksigner" ]; then
      export PATH="$ANDROID_HOME/build-tools/$(ls -1 $ANDROID_HOME/build-tools | sort -V | tail -n1):$PATH"
    fi
  fi
  if ! command -v apksigner >/dev/null 2>&1; then
    echo "Warning: 'apksigner' not found on PATH. Skipping signing fallback." >&2
  else
    OUT_APK="./app-release-signed.apk"
    if [ -n "$KS_FILE$KS_ALIAS$KS_PASS$KEY_PASS" ]; then
      echo "Signing with provided keystore: $KS_FILE (alias: $KS_ALIAS)" >&2
      apksigner sign --ks "$KS_FILE" --ks-key-alias "$KS_ALIAS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" --out "$OUT_APK" "$UNSIGNED_APK"
    else
      # Generate a debug keystore locally
      KS_FILE="./android-debug.keystore"
      KS_ALIAS="androiddebugkey"
      KS_PASS="android"
      KEY_PASS="android"
      if [ ! -f "$KS_FILE" ]; then
        if ! command -v keytool >/dev/null 2>&1; then
          echo "Error: 'keytool' is required to generate a debug keystore. Install Java JDK." >&2
          exit 6
        fi
        echo "Generating debug keystore at $KS_FILE ..." >&2
        keytool -genkeypair -keystore "$KS_FILE" -storepass "$KS_PASS" -keypass "$KEY_PASS" -alias "$KS_ALIAS" -dname "CN=TickTock Dev, OU=, O=TickTock, L=, S=, C=US" -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
      fi
      echo "Signing with debug keystore (alias: $KS_ALIAS)" >&2
      apksigner sign --ks "$KS_FILE" --ks-key-alias "$KS_ALIAS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" --out "$OUT_APK" "$UNSIGNED_APK"
    fi

    # Verify signature
    if command -v apksigner >/dev/null 2>&1; then
      apksigner verify --print-certs "$OUT_APK" || true
    fi
    APK_PATH="$OUT_APK"
  fi
fi

echo ""
echo "Build completed. Output files:"
if [ -n "$APK_PATH" ]; then
  echo " - APK: $APK_PATH"
fi
if [ -n "$AAB_PATH" ]; then
  echo " - AAB: $AAB_PATH"
fi
if [ -z "$APK_PATH" ] && [ -z "$AAB_PATH" ]; then
  echo "(Could not auto-detect outputs. Check the ./android/app/build/ outputs.)"
fi

echo ""
echo "Next steps:"
echo " - Sideload the APK on your Android device (enable 'install from unknown sources')."
echo " - Or use the AAB for Play Store (requires signing and Play Console)."
