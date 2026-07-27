# Engineering handbook

This directory is the maintained project memory. Markdown is deliberate: GitHub renders it directly, diffs it cleanly, and coding agents can cite stable sections without parsing decorative HTML.

## Read in this order

1. [`architecture.md`](architecture.md) — system boundaries and runtime topology
2. [`migration-strategy.md`](migration-strategy.md) — how WordPress data crosses into the new model
3. [`frontend.md`](frontend.md) — React admin conventions and extension guide
4. [`backend.md`](backend.md) — Nest, database, job and observability conventions
5. [`decisions/0001-platform.md`](decisions/0001-platform.md) — accepted platform decision
6. [`decisions/0002-wordpress-boundary.md`](decisions/0002-wordpress-boundary.md) — transitional WordPress/payment boundary
7. [`decisions/0003-rendering.md`](decisions/0003-rendering.md) — Nuxt rendering policy
8. [`decisions/0004-admin-only-boundary.md`](decisions/0004-admin-only-boundary.md) — admin/public product ownership boundary
9. [`decisions/0005-theming-and-dark-mode.md`](decisions/0005-theming-and-dark-mode.md) — design tokens and light/dark theming
10. [`decisions/0006-react-admin-runtime.md`](decisions/0006-react-admin-runtime.md) — React admin runtime (supersedes the Nuxt frontend)
11. [`decisions/0007-mongodb-conversation-authority.md`](decisions/0007-mongodb-conversation-authority.md) — MongoDB conversation authority and PostgreSQL recovery boundary
12. [`decisions/0008-post-event-feedback-conversations.md`](decisions/0008-post-event-feedback-conversations.md) — event-bound WhatsApp feedback, directed results and human control
13. [`decisions/0009-generated-api-client.md`](decisions/0009-generated-api-client.md) — generated admin API client (supersedes hand-written response schemas)
14. [`decisions/0010-generated-client-not-committed.md`](decisions/0010-generated-client-not-committed.md) — generated admin client is local output, not a committed artifact (supersedes that consequence of ADR 0009)
15. [`deployment.md`](deployment.md) — development containers and production VPS topology
16. [`agent-readiness.md`](agent-readiness.md) — repeatable extension benchmark and current evidence gaps

Area-specific memory:

- [`frontend/components/README.md`](frontend/components/README.md) — reusable component inventory and selection hierarchy
- [`frontend/theming.md`](frontend/theming.md) — design tokens, dark mode and the HeroUI integration
- [`frontend/assistant.md`](frontend/assistant.md) — queue-backed AI conversation route and polling contract
- [`frontend/feedback-conversations.md`](frontend/feedback-conversations.md) — post-event feedback inbox, capability-gated actions and results
- [`backend/mechanisms/README.md`](backend/mechanisms/README.md) — queue, database and runtime operations contracts
- [`backend/mechanisms/api-contract.md`](backend/mechanisms/api-contract.md) — OpenAPI emission, admin client generation and drift detection
- [`backend/mechanisms/mongodb.md`](backend/mechanisms/mongodb.md) — conversation-store lifecycle, security, limits and backup
- [`backend/mechanisms/local-data-query.md`](backend/mechanisms/local-data-query.md) — guarded local PostgreSQL, MongoDB and Redis inspection
- [`backend/mechanisms/authentication.md`](backend/mechanisms/authentication.md) — Clerk identity, admin authorization and restricted-Google handoff
- [`backend/mechanisms/wasender.md`](backend/mechanisms/wasender.md) — opt-in WhatsApp transport and webhook boundary
- [`backend/modules/README.md`](backend/modules/README.md) — product-domain module inventory and lifecycle docs
- [`backend/modules/conversations.md`](backend/modules/conversations.md) — owner-scoped MongoDB conversation aggregate
- [`backend/modules/events.md`](backend/modules/events.md) — stub events, attendance and feedback-candidate helper
- [`backend/modules/post-event-feedback.md`](backend/modules/post-event-feedback.md) — accepted campaign, directed feedback, PostgreSQL persistence and human-takeover contract
- [`backend/modules/participants.md`](backend/modules/participants.md) — participant profile schema, feedback opt-in and WordPress import runbook
- [`evidence/README.md`](evidence/README.md) — audits and scope reviews, each fixed to the date it was taken
- [`history/README.md`](history/README.md) — plans that have been carried out; read for _why_, never as instruction
- [`documentation-standard.md`](documentation-standard.md) — required shape for new component/mechanism documentation

## Evidence, decisions and implementation

- Evidence records what was observed, at a date, and must remain factual. See [`evidence/README.md`](evidence/README.md).
- Architecture Decision Records explain decisions and their consequences.
- Frontend/backend handbooks define current implementation conventions.
- Code is not allowed to quietly contradict any of the above. If reality changes, update the document in the same pull request.

Every implementation change includes a documentation-impact check. Reusable
component contracts, mechanism flows, dependency guidance, configuration and
accepted decisions are updated with the code—not assigned to a hypothetical
future archaeologist.

Run `pnpm docs:check` to verify required instruction files, relative links,
Mermaid fences and orphaned documentation. It is also part of `pnpm check` and
therefore CI.

## Repository automation

The root [`package.json`](../package.json) is the developer command surface; the
quick start remains in the root [`README.md`](../README.md). Turborepo owns
workspace dependency ordering and cache contracts in [`turbo.json`](../turbo.json):

- `pnpm dev` loads the root `.env`, starts the native admin, Nest and worker
  processes, and passes only their declared runtime variables through Turbo.
- `pnpm check` runs formatting, documentation, generated-API drift, typecheck,
  lint, test and build in that order. The Turbo phases remain separate so a
  failure names the phase that broke rather than a merged graph.
- `pnpm api:generate` re-emits `apps/backend/openapi/openapi.json` from the Nest
  controllers and regenerates `apps/admin/src/api/generated/` (gitignored).
  `pnpm api:check` does the same and fails when the committed OpenAPI document
  changed.
- `pnpm install --frozen-lockfile` is the clean-machine and CI contract. pnpm
  rejects workspace cycles and unreviewed dependency build scripts.
- GitHub Actions repeats that clean check and builds production images without
  pushing or deploying them. Production rollout remains a deliberate VPS
  operation documented in [`deployment.md`](deployment.md).

The current contracts were checked on 2026-07-22 against
[pnpm 10 workspace settings](https://pnpm.io/10.x/settings),
[Turborepo task configuration](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
and [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## Current delivery target

Build one audited vertical slice before broad CRUD coverage:

`participant -> booking -> payment ledger -> event/table assignment -> attendance -> feedback`

Safety, consent and audit are part of that slice, not a mythical “hardening phase” after launch.
