# Join The Six

Production foundation for the private Join The Six administration and operator application.

Public marketing, registration and participant-facing journeys live in the
existing Next.js application at `legacy.example.com`; they are deliberately outside
this repository.

## Stack

- `apps/admin`: private React, HeroUI and Tailwind administration panel
- `apps/backend`: NestJS modular monolith with separate API and worker processes
- `packages/database`: PostgreSQL schema and versioned Drizzle migrations
- MongoDB for authoritative owner-scoped conversation threads and ordered turns
- Redis and BullMQ for observable background jobs
- pnpm workspaces and Turborepo on Node.js 24 LTS

WordPress remains a temporary, isolated integration and migration boundary. It is not the schema for the new product.

## Start locally

The normal development loop runs PostgreSQL, MongoDB and Redis in containers,
while the admin client, Nest and the worker run natively with hot reload:

```bash
cp .env.example .env
# Fill the matching Clerk keys, CLERK_ADMIN_USER_IDS and at least one AI key.
pnpm install
pnpm infra:up
pnpm dev
```

Useful local commands once the stack is up:

```bash
pnpm feedback:simulate --list
pnpm feedback:burst
```

`pnpm feedback:burst` seeds six finished events, launches thirty-six concurrent
post-event feedback conversations, and writes
`report/feedback-burst-<timestamp>.html`. Default mode is the free deterministic
stub (`FEEDBACK_EXTRACTION_STUB=true`); paid provider mode needs `--model` and
`--confirm-paid-run`. It never cleans up.

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
plus PostgreSQL, MongoDB, Redis and Caddy for TLS/reverse proxying:

```bash
cp .env.production.example .env.production
install -d -m 700 secrets
umask 077
openssl rand -hex 32 > secrets/postgres_password
openssl rand -hex 32 > secrets/mongodb_root_password
openssl rand -hex 32 > secrets/mongodb_app_password
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

Start at [`docs/README.md`](docs/README.md). The existing read-only WordPress evidence is in [`WP_AUDIT_2026-07-22.md`](docs/evidence/wordpress-audit-2026-07-22.md).

Do not add business entities or WordPress mappings from memory. Update the relevant contract or migration map first, then implement a vertical slice.
