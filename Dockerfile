FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY packages ./packages
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY . .
RUN npm run build && npm --prefix web run build

FROM dependencies AS runtime
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl dumb-init && rm -rf /var/lib/apt/lists/*
RUN npx playwright install --with-deps chromium webkit
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/mitmproxy \
  && /opt/mitmproxy/bin/pip install --no-cache-dir mitmproxy==11.0.2 \
  && ln -s /opt/mitmproxy/bin/mitmdump /usr/local/bin/mitmdump
COPY --chown=node:node --from=build /app /app
RUN mkdir -p /app/runs && chown node:node /app/runs

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "--workspace", "web", "run", "start"]
