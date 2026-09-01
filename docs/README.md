# Engineering handbook

Maintained project memory for **Slopform**. Markdown stays deliberate: GitHub
renders it, diffs stay clean, and agents can cite stable sections. Public
identity and leftover Join The Six compatibility IDs:
[ADR 0014](decisions/0014-public-slopform-identity.md).

## Read in this order

Core handbooks, then ADRs in number order, then ops and the readiness record:

1. [`architecture.md`](architecture.md) — boundaries and runtime topology
2. [`migration-strategy.md`](migration-strategy.md) — WordPress → new model
3. [`frontend.md`](frontend.md) — React admin conventions
4. [`backend.md`](backend.md) — Nest, DB, jobs, observability
5. [`decisions/0001-platform.md`](decisions/0001-platform.md) — platform
6. [`decisions/0002-wordpress-boundary.md`](decisions/0002-wordpress-boundary.md) — WordPress/payment boundary
7. [`decisions/0003-rendering.md`](decisions/0003-rendering.md) — Nuxt policy _(superseded by 0006)_
8. [`decisions/0004-admin-only-boundary.md`](decisions/0004-admin-only-boundary.md) — admin/public ownership
9. [`decisions/0005-theming-and-dark-mode.md`](decisions/0005-theming-and-dark-mode.md) — tokens and light/dark
10. [`decisions/0006-react-admin-runtime.md`](decisions/0006-react-admin-runtime.md) — React admin _(supersedes Nuxt)_
11. [`decisions/0007-mongodb-conversation-authority.md`](decisions/0007-mongodb-conversation-authority.md) — Mongo conversation authority
12. [`decisions/0008-post-event-feedback-conversations.md`](decisions/0008-post-event-feedback-conversations.md) — WhatsApp feedback + human control
13. [`decisions/0009-generated-api-client.md`](decisions/0009-generated-api-client.md) — generated admin API client
14. [`decisions/0010-generated-client-not-committed.md`](decisions/0010-generated-client-not-committed.md) — client is local output _(narrows 0009)_
15. [`decisions/0011-display-typeface.md`](decisions/0011-display-typeface.md) — Commissioner + Manrope _(narrows 0005)_
16. [`decisions/0012-selectable-palettes.md`](decisions/0012-selectable-palettes.md) — palette axis _(narrows 0005)_
17. [`decisions/0013-state-driven-feedback-orchestration.md`](decisions/0013-state-driven-feedback-orchestration.md) — state reconciliation + outbox _(supersedes Redis execution from 0008)_
18. [`decisions/0014-public-slopform-identity.md`](decisions/0014-public-slopform-identity.md) — public Slopform name; leftover Join The Six IDs
19. [`deployment.md`](deployment.md) — local containers and example VPS layout
20. [`agent-readiness.md`](agent-readiness.md) — dated extension benchmark _(repeat after material architecture change)_

## Area index

**Frontend**

- [`frontend/components/README.md`](frontend/components/README.md) — reusable inventory
- [`frontend/theming.md`](frontend/theming.md) — tokens, dark mode, HeroUI
- [`frontend/assistant.md`](frontend/assistant.md) — AI conversation UI contract
- [`frontend/admin-cookbook.md`](frontend/admin-cookbook.md) — visual vocabulary page
- [`frontend/feedback-conversations.md`](frontend/feedback-conversations.md) — feedback inbox
- [`frontend/feedback-outbound-queue.md`](frontend/feedback-outbound-queue.md) — outbound queue + decision log

**Backend mechanisms** — start at [`backend/mechanisms/README.md`](backend/mechanisms/README.md)

- [`api-contract.md`](backend/mechanisms/api-contract.md) · [`queues.md`](backend/mechanisms/queues.md) · [`database.md`](backend/mechanisms/database.md) · [`runtime-operations.md`](backend/mechanisms/runtime-operations.md)
- [`assistant-streaming.md`](backend/mechanisms/assistant-streaming.md) · [`mongodb.md`](backend/mechanisms/mongodb.md) · [`local-data-query.md`](backend/mechanisms/local-data-query.md)
- [`authentication.md`](backend/mechanisms/authentication.md) · [`wasender.md`](backend/mechanisms/wasender.md)

**Backend modules** — start at [`backend/modules/README.md`](backend/modules/README.md)

- [`conversations.md`](backend/modules/conversations.md) · [`events.md`](backend/modules/events.md) · [`participants.md`](backend/modules/participants.md)
- [`post-event-feedback.md`](backend/modules/post-event-feedback.md)

**Meta**

- [`evidence/README.md`](evidence/README.md) — dated audits (do not update as living truth)
- [`history/README.md`](history/README.md) — carried-out plans; read for _why_, never as instruction
- [`documentation-standard.md`](documentation-standard.md) — shape for new component/mechanism docs

## Evidence, decisions and implementation

Evidence is dated observation. ADRs record decisions and consequences. Handbooks
state current conventions. Code must not quietly contradict any of them — update
the doc in the same PR when reality changes.

`pnpm docs:check` verifies instruction files, relative links, Mermaid fences,
orphaned docs, and inline `apps/` / `packages/` / `scripts/` source paths
(`.ts`, `.tsx`, `.mjs`, `.json`, `.css`). `docs/decisions/` and `docs/history/`
are exempt so records can name deleted files. Part of `pnpm check` / CI. It does
**not** resolve `#anchor` fragments or check shell scripts.

## Repository automation

Root [`package.json`](../package.json) is the command surface; quick start is
[`README.md`](../README.md). [`turbo.json`](../turbo.json) owns ordering and cache:

- `pnpm dev` — root `.env`, native admin + Nest + worker with declared env only
- `pnpm check` — format → docs → API drift → typecheck → lint → test → script tests → build
- `pnpm api:generate` / `pnpm api:check` — emit OpenAPI + regenerate gitignored admin client; check fails on committed OpenAPI drift
- `pnpm install --frozen-lockfile` — clean-machine / CI install
- GitHub Actions runs the clean check and builds images without deploy; rollout is in [`deployment.md`](deployment.md)

Contracts last checked 2026-07-22 against [pnpm 10 settings](https://pnpm.io/10.x/settings),
[Turborepo tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
and [Actions secure-use](https://docs.github.com/en/actions/reference/security/secure-use).

## Current delivery target

The realized operator loop is:

`campaign + questions → WhatsApp conversation → extraction → outbox → review → summary`

The longer dinner-product slice from the Join The Six era remains the domain
direction, not a claim that every entity is live CRUD:

`participant → booking → payment ledger → event/table assignment → attendance → feedback`

Safety, consent and audit belong in that slice, not a later “hardening phase”.
