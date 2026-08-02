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

## Production

Production keeps native nginx as the shared VPS TLS edge. Docker runs separate
`web`, `api`, `worker` and one-shot `migrate` images plus PostgreSQL, MongoDB and
Redis; application ports bind to loopback only.

One operator interface owns release transfer, component deploys, rollback,
status/logs and the temporary pre-launch data-import window:

```bash
pnpm prod deploy              # all components
pnpm prod deploy admin        # SPA only
pnpm prod deploy backend      # migrate + API + worker
pnpm prod status
pnpm prod logs worker
pnpm prod data status
```

It deploys only a clean committed `HEAD`, transfers that exact tree as an
immutable release over SSH and never sends local secrets or Docker volumes.
Initial configuration, restricted Clerk setup, repeatable PostgreSQL/MongoDB
promotion, `data seal`, nginx cutover and rollback are documented in
[`docs/deployment.md`](docs/deployment.md). Do not replace the phased command
with a blanket `docker compose up`; that can recreate application processes
before the migration gate has succeeded.

## Documentation

Start at [`docs/README.md`](docs/README.md). The existing read-only WordPress evidence is in [`WP_AUDIT_2026-07-22.md`](docs/evidence/wordpress-audit-2026-07-22.md).

Do not add business entities or WordPress mappings from memory. Update the relevant contract or migration map first, then implement a vertical slice.
