# Join The Six

Production foundation for the private Join The Six administration and operator application.

Public marketing, registration and participant-facing journeys live in the
existing Next.js application at `legacy.example.com`; they are deliberately outside
this repository.

## Stack

- `apps/admin`: private React, HeroUI and Tailwind administration panel
- `apps/backend`: NestJS modular monolith with separate API and worker processes
- `packages/database`: PostgreSQL schema and versioned Drizzle migrations
- Redis and BullMQ for observable background jobs
- pnpm workspaces and Turborepo on Node.js 24 LTS

WordPress remains a temporary, isolated integration and migration boundary. It is not the schema for the new product.

## Start locally

The normal development loop runs PostgreSQL and Redis in containers, while the
admin client, Nest and the worker run natively with hot reload:

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

To run the application processes in containers too:

```bash
pnpm dev:containers:build
pnpm dev:containers
```

Rebuild the development image after dependency manifest or lockfile changes;
ordinary source edits use the bind mount and hot reload.

Run the full repository check with:

```bash
pnpm check
```

## Production containers

Production uses separate `web`, `api`, `worker` and one-shot `migrate` images,
plus PostgreSQL, Redis and Caddy for TLS/reverse proxying:

```bash
cp .env.production.example .env.production
install -d -m 700 secrets
umask 077
openssl rand -hex 32 > secrets/postgres_password
openssl rand -hex 32 > secrets/redis_password
# Replace every placeholder before continuing.
docker compose --env-file .env.production -f compose.prod.yaml config --quiet
docker compose --env-file .env.production -f compose.prod.yaml build --pull
docker compose --env-file .env.production -f compose.prod.yaml up -d \
  --no-build --remove-orphans --wait
```

Deployment, rollback and VPS CI guidance lives in
[`docs/deployment.md`](docs/deployment.md). Automatic production deployment is
deliberately not wired until the VPS target and rollback policy are known.

## Documentation

Start at [`docs/README.md`](docs/README.md). The existing read-only WordPress evidence is in [`WP_AUDIT_2026-07-22.md`](WP_AUDIT_2026-07-22.md).

Do not add business entities or WordPress mappings from memory. Update the relevant contract or migration map first, then implement a vertical slice.
