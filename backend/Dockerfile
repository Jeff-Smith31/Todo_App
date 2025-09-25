# Use Node LTS
FROM node:20-alpine

WORKDIR /app

# Install dependencies and tools (openssl for cert generation, curl for healthcheck)
RUN apk add --no-cache openssl curl
COPY backend/package.json ./package.json
RUN npm install --omit=dev

# Copy app source and entrypoint
COPY backend/index.js ./index.js
COPY backend/dynamo.js ./dynamo.js
# Bundle a copy of the frontend to serve as a standalone app from the backend at /app
COPY frontend/website ./public
COPY backend/entrypoint-https.sh ./entrypoint-https.sh
RUN chmod +x ./entrypoint-https.sh

# Create certs path
RUN mkdir -p /certs

# Env defaults
ENV PORT=8080
ENV HTTPS_PORT=8443
ENV HTTPS_CERT_PATH=/certs/dev-cert.pem
ENV HTTPS_KEY_PATH=/certs/dev-key.pem
EXPOSE 8080 8443

CMD ["/app/entrypoint-https.sh"]
