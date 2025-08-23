#!/usr/bin/env sh
set -e

CERT_DIR="${CERT_DIR:-/certs}"
CERT_FILE="${HTTPS_CERT_PATH:-$CERT_DIR/dev-cert.pem}"
KEY_FILE="${HTTPS_KEY_PATH:-$CERT_DIR/dev-key.pem}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
# Comma-separated hosts for SAN (IP or DNS). Default includes localhost and the example LAN IP.
CERT_HOSTS="${CERT_HOSTS:-localhost,192.168.1.6}"

mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "Generating self-signed development TLS certificate..."
  # Build SAN list
  SAN_ENTRIES=""
  IFS=','
  for h in $CERT_HOSTS; do
    case "$h" in
      *.*.*.*) SAN_ENTRIES="${SAN_ENTRIES},IP:${h}" ;;
      *) SAN_ENTRIES="${SAN_ENTRIES},DNS:${h}" ;;
    esac
  done
  SAN_ENTRIES="${SAN_ENTRIES#,}"

  OPENSSL_CNF="/tmp/openssl-ticktock.cnf"
  cat > "$OPENSSL_CNF" <<EOF
[ req ]
default_bits       = 2048
distinguished_name = req_distinguished_name
req_extensions     = v3_req
prompt             = no

[ req_distinguished_name ]
CN = TickTock Dev
O  = TickTock
C  = US

[ v3_req ]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${SAN_ENTRIES}
EOF

  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$KEY_FILE" -out "$CERT_FILE" -config "$OPENSSL_CNF"
  echo "Self-signed cert created at $CERT_FILE with SAN: $SAN_ENTRIES"
fi

# Export back the resolved paths for Node to read
export HTTPS_CERT_PATH="$CERT_FILE"
export HTTPS_KEY_PATH="$KEY_FILE"

# Start the app
exec node --no-deprecation index.js
