# Slopform

The form is texting you now.

Slopform is a private operator system for conversational research. Operators
configure a campaign and its questions. AI-guided WhatsApp conversations collect
the answers. An admin surface manages delivery, transcripts, human review,
outbox state, retries, idempotency, queues and summaries.

This repository is the source tree for that system, published as a portfolio
codebase. It is not a public SaaS and does not claim users or traction. The
committed defaults use simulated delivery; real WhatsApp egress is
configuration-gated, and campaign eligibility requires an operator-managed
participant opt-in. Legal and provider approval remain deployment gates rather
than claims made by this repository.

The stack was originally built as the Join The Six operator application.
Historical ADRs, guest fixtures and participant-facing policy copy keep that
context. Public documentation and committed deploy examples use Slopform
([ADR 0014](docs/decisions/0014-public-slopform-identity.md)).

## Stack

- `apps/admin`: private React, HeroUI and Tailwind operator panel
- `apps/backend`: NestJS modular monolith with separate API and worker processes
- `packages/database`: PostgreSQL schema and versioned Drizzle migrations
- MongoDB for authoritative owner-scoped conversation threads and ordered turns
- Redis and BullMQ for observable background jobs
- pnpm workspaces and Turborepo on Node.js 24 LTS

WordPress remains a documented historical migration boundary from the Join The
Six era. It is not the schema for this product, and this tree does not include a
live-site export recipe or WordPress credentials.

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
stub (`FEEDBACK_EXTRACTION_STUB=true`); the frozen direct-OpenAI Luna medium
treatment needs `--profile prova --confirm-paid-run`. Qwen is a separately
labelled `--comparison qwen` run; a free-form `--model` is rejected. It never
cleans up. Burst HTML and other `report/` output stay gitignored.

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

## Example production layout

Committed deploy examples use `slopform.example.com`, RFC 5737 documentation
addresses such as `203.0.113.10`, and `/opt/slopform`. They describe how an
operator would run a **private** instance behind native nginx. They are not a
public production service and must not be copied as if they were a live zone.

Native nginx owns 80/443. Docker runs separate `web`, `api`, `worker` and
one-shot `migrate` images plus PostgreSQL, MongoDB and Redis; application ports
bind to loopback only.

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
Example configuration, restricted Clerk setup, repeatable PostgreSQL/MongoDB
promotion, `data seal`, nginx cutover and rollback are documented in
[`docs/deployment.md`](docs/deployment.md). Do not replace the phased command
with a blanket `docker compose up`; that can recreate application processes
before the migration gate has succeeded.

## Documentation

Start at [`docs/README.md`](docs/README.md). Dated evidence is indexed from
[`docs/evidence/README.md`](docs/evidence/README.md). Public identity and the
legacy identifiers this tree deliberately keeps are in
[ADR 0014](docs/decisions/0014-public-slopform-identity.md).

Unresolved engineering work is tracked in [`TODO.md`](TODO.md); dated evidence
and completed plans are not active task lists.

Do not add business entities or WordPress mappings from memory. Update the
relevant contract or migration map first, then implement a vertical slice.

This repository does not currently select or ship a software license.
