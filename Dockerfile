# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.11.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
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
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile

FROM dependencies AS development
ENV NODE_ENV=development
COPY . .
CMD ["pnpm", "dev"]

FROM development AS build
ENV NODE_ENV=production
RUN pnpm --filter @join-the-six/web exec nuxt prepare && pnpm build

FROM build AS backend-package
RUN pnpm --filter @join-the-six/backend deploy --prod --legacy /opt/backend

FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/web/.output ./
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]

FROM node:${NODE_VERSION}-bookworm-slim AS backend-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=backend-package --chown=node:node /opt/backend ./
USER node

FROM backend-runtime AS api
EXPOSE 4000
CMD ["node", "--import", "./dist/instrumentation.js", "./dist/main-http.js"]

FROM backend-runtime AS worker
CMD ["node", "--import", "./dist/instrumentation.js", "./dist/main-worker.js"]

FROM development AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@join-the-six/database", "db:migrate"]
