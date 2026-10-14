FROM node:24-bookworm-slim AS build
# Tests exercise the same curl transport the app uses at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run typecheck && npm test
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Named volumes inherit this ownership on their first mount.
RUN mkdir -p /data /run/tekiya-admin \
    && chown node:node /data /run/tekiya-admin \
    && chmod 0700 /run/tekiya-admin
USER node
ENV NYM_DATA=/data
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["serve"]
