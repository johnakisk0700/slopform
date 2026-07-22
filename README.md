# Join The Six

Production foundation for the Join The Six operator application and public intake flows.

## Stack

- `apps/web`: Nuxt, Vue, PrimeVue and Motion for Vue
- `apps/backend`: NestJS modular monolith with separate API and worker processes
- `packages/database`: PostgreSQL schema and versioned Drizzle migrations
- Redis and BullMQ for observable background jobs
- pnpm workspaces and Turborepo on Node.js 24 LTS

WordPress remains a temporary, isolated integration and migration boundary. It is not the schema for the new product.

## Start locally

The normal development loop runs PostgreSQL and Redis in containers, while Nuxt,
Nest and the worker run natively with hot reload:

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

To run the application processes in containers too:

```bash
pnpm dev:containers
```

Run the full repository check with:

```bash
pnpm check
```

## Production containers

Production uses separate `web`, `api`, `worker` and one-shot `migrate` images,
plus PostgreSQL, Redis and Caddy for TLS/reverse proxying:

```bash
cp .env.production.example .env.production
# Replace every placeholder before continuing.
docker compose --env-file .env.production -f compose.prod.yaml config --quiet
docker compose --env-file .env.production -f compose.prod.yaml up -d --build
```

Deployment, rollback and VPS CI guidance lives in
[`docs/deployment.md`](docs/deployment.md). Automatic production deployment is
deliberately not wired until the VPS target and rollback policy are known.

## Documentation

Start at [`docs/README.md`](docs/README.md). The existing read-only WordPress evidence is in [`WP_AUDIT_2026-07-22.md`](WP_AUDIT_2026-07-22.md).

Do not add business entities or WordPress mappings from memory. Update the relevant contract or migration map first, then implement a vertical slice.
