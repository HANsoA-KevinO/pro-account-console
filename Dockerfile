FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.159.2
RUN npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force

# The Codex quota reader requires system CA certificates for HTTPS.
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*


WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY vendor/modeltrace/ ./vendor/modeltrace/
RUN mkdir -p /var/lib/pro-account-console && chown node:node /var/lib/pro-account-console

ENV NODE_ENV=production \
    GATEWAY_PORT=8787 \
    GATEWAY_BIND_HOST=127.0.0.1 \
    GATEWAY_REQUIRE_ADMIN=true \
    GATEWAY_DATA_DIR=/var/lib/pro-account-console \
    GATEWAY_UPSTREAM_SESSION_TRANSPORT=http \
    GATEWAY_CODEX_BIN=/usr/local/bin/codex

USER node
VOLUME ["/var/lib/pro-account-console"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.GATEWAY_PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs", "--server"]
