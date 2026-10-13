FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.159.2
RUN npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force

# Codex uses the operating system's trust store; Node's bundled CA roots are
# insufficient for the separate Rust CLI's HTTPS requests.
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
ENV NODE_ENV=production GATEWAY_CODEX_BIN=/usr/local/bin/codex
USER node
EXPOSE 18787
CMD ["node","lib/cloudflare-start.mjs"]
