# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

ARG NODE_IMAGE=node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /workspace

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile

FROM dependencies AS development
ENV NODE_ENV=development
CMD ["pnpm", "dev"]

FROM dependencies AS build
ENV NODE_ENV=production
ENV NUXT_TELEMETRY_DISABLED=1
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN --network=none pnpm --filter @join-the-six/web exec nuxt prepare && pnpm build

FROM build AS backend-package
RUN --network=none --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --config.inject-workspace-packages=true \
    --filter @join-the-six/backend deploy --prod --offline /opt/backend

FROM dependencies AS database-package
COPY packages/database/drizzle packages/database/drizzle
RUN --network=none --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --config.inject-workspace-packages=true \
    --filter @join-the-six/database deploy --prod --offline /opt/database

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS secret-runtime
COPY --chmod=0555 docker/run-with-secrets.sh /usr/local/bin/run-with-secrets
ENTRYPOINT ["run-with-secrets"]

FROM runtime AS web
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
COPY --from=build --chown=node:node /workspace/apps/web/.output ./
EXPOSE 3000
CMD ["node", "server/index.mjs"]

FROM secret-runtime AS backend-runtime
COPY --from=backend-package --chown=node:node /opt/backend ./

FROM backend-runtime AS api
EXPOSE 4000
CMD ["node", "--import", "./dist/instrumentation.js", "./dist/main-http.js"]

FROM backend-runtime AS worker
CMD ["node", "--import", "./dist/instrumentation.js", "./dist/main-worker.js"]

FROM secret-runtime AS migrate
COPY --from=database-package --chown=node:node /opt/database ./
COPY --chown=node:node docker/migrate.mjs ./migrate.mjs
RUN node --check ./migrate.mjs && \
  node --input-type=module --eval "await import('drizzle-orm/node-postgres/migrator'); await import('pg')"
CMD ["node", "./migrate.mjs"]
