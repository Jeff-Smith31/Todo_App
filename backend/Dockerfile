# Use Node LTS
FROM node:20-alpine

WORKDIR /app

# Install dependencies and openssl for cert generation
RUN apk add --no-cache openssl
COPY backend/package.json ./package.json
RUN npm install --omit=dev

# Copy app source and entrypoint
COPY backend/index.js ./index.js
COPY backend/entrypoint-https.sh ./entrypoint-https.sh
RUN chmod +x ./entrypoint-https.sh

# Create data and certs paths
VOLUME ["/data"]
ENV SQLITE_FILE=/data/data.sqlite
RUN mkdir -p /certs

# Env defaults
ENV PORT=8080
ENV HTTPS_PORT=8443
ENV HTTPS_CERT_PATH=/certs/dev-cert.pem
ENV HTTPS_KEY_PATH=/certs/dev-key.pem
EXPOSE 8080 8443

CMD ["/app/entrypoint-https.sh"]
