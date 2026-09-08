# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

ARG NODE_IMAGE=node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/corepack
RUN corepack enable && \
  corepack prepare pnpm@10.33.0 --activate && \
  chmod -R a+rX /corepack
WORKDIR /workspace

FROM base AS clustering-dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 && \
  rm -rf /var/lib/apt/lists/*
COPY apps/topic-clustering/requirements.lock /opt/topic-clustering/requirements.lock
RUN python3 -m venv /opt/topic-clustering/.venv && \
  /opt/topic-clustering/.venv/bin/python -m pip install --no-cache-dir --no-deps \
    --require-hashes --only-binary=:all: -r /opt/topic-clustering/requirements.lock && \
  /opt/topic-clustering/.venv/bin/python -I -B -c "from bertopic import BERTopic; from sklearn.cluster import HDBSCAN"

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY harness/package.json harness/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile

FROM dependencies AS development
RUN apt-get update && apt-get install -y --no-install-recommends python3 libgomp1 && \
  rm -rf /var/lib/apt/lists/*
COPY --from=clustering-dependencies /opt/topic-clustering /opt/topic-clustering
ARG DEV_GID=1000
ARG DEV_UID=1000
ENV NODE_ENV=development
ENV HOME=/home/node
RUN groupmod --non-unique --gid "${DEV_GID}" node && \
  usermod --non-unique --uid "${DEV_UID}" --gid "${DEV_GID}" node && \
  chown node:node /home/node
USER node
CMD ["pnpm", "dev"]

FROM dependencies AS build
ARG VITE_API_BASE=/api
ARG VITE_CLERK_PUBLISHABLE_KEY=
ARG VITE_GOOGLE_MAPS_API_KEY=
ENV NODE_ENV=production
ENV TURBO_TELEMETRY_DISABLED=1
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
COPY . .
RUN --network=none pnpm build

FROM build AS backend-package
RUN --network=none --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --config.inject-workspace-packages=true \
    --filter @slopform/backend deploy --prod --offline /opt/backend

FROM dependencies AS database-package
COPY packages/database/drizzle packages/database/drizzle
RUN --network=none --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --config.inject-workspace-packages=true \
    --filter @slopform/database deploy --prod --offline /opt/database

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS secret-runtime
COPY --chmod=0555 docker/run-with-secrets.sh /usr/local/bin/run-with-secrets
ENTRYPOINT ["run-with-secrets"]

# The admin client is a static SPA, so the web tier is a file server rather
# than a Node runtime. Caddy serves the Vite build and falls back to index.html
# for client-side routes (see docker/web.Caddyfile).
FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS web
ARG RELEASE_TAG=unknown
ARG WEB_PUBLIC_CONFIG_SHA256=unconfigured
COPY --from=build /workspace/apps/admin/dist /srv
COPY docker/web.Caddyfile /etc/caddy/Caddyfile
RUN setcap -r /usr/bin/caddy && \
  case "$RELEASE_TAG" in ""|*[!A-Za-z0-9_.-]*) exit 1 ;; esac && \
  printf '{"release":"%s"}\n' "$RELEASE_TAG" > /srv/deploy.json
LABEL org.opencontainers.image.revision=$RELEASE_TAG
LABEL org.join-the-six.web-public-config-sha256=$WEB_PUBLIC_CONFIG_SHA256
EXPOSE 3000

FROM secret-runtime AS backend-runtime
COPY --from=backend-package --chown=node:node /opt/backend ./

FROM backend-runtime AS api
ARG RELEASE_TAG=unknown
LABEL org.opencontainers.image.revision=$RELEASE_TAG
EXPOSE 4000
CMD ["node", "./dist/main-http.js"]

FROM backend-runtime AS worker
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 libgomp1 && \
  rm -rf /var/lib/apt/lists/*
COPY --from=clustering-dependencies /opt/topic-clustering /opt/topic-clustering
COPY apps/topic-clustering/cluster.py /opt/topic-clustering/cluster.py
ENV PYTHONDONTWRITEBYTECODE=1
USER node
ARG RELEASE_TAG=unknown
LABEL org.opencontainers.image.revision=$RELEASE_TAG
CMD ["node", "./dist/main-worker.js"]

FROM secret-runtime AS migrate
ARG RELEASE_TAG=unknown
COPY --from=database-package --chown=node:node /opt/database ./
COPY --chown=node:node docker/migrate.mjs ./migrate.mjs
RUN node --check ./migrate.mjs && \
  node --input-type=module --eval "await import('drizzle-orm/node-postgres/migrator'); await import('pg')"
LABEL org.opencontainers.image.revision=$RELEASE_TAG
CMD ["node", "./migrate.mjs"]
