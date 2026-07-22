# Engineering handbook

This directory is the maintained project memory. Markdown is deliberate: GitHub renders it directly, diffs it cleanly, and coding agents can cite stable sections without parsing decorative HTML.

## Read in this order

1. [`architecture.md`](architecture.md) — system boundaries and runtime topology
2. [`migration-strategy.md`](migration-strategy.md) — how WordPress data crosses into the new model
3. [`frontend.md`](frontend.md) — Nuxt conventions and extension guide
4. [`backend.md`](backend.md) — Nest, database, job and observability conventions
5. [`decisions/0001-platform.md`](decisions/0001-platform.md) — accepted platform decision
6. [`decisions/0002-wordpress-boundary.md`](decisions/0002-wordpress-boundary.md) — transitional WordPress/payment boundary
7. [`decisions/0003-rendering.md`](decisions/0003-rendering.md) — Nuxt rendering policy
8. [`deployment.md`](deployment.md) — development containers and production VPS topology

## Evidence, decisions and implementation

- Evidence records what exists and must remain factual. See [`../WP_AUDIT_2026-07-22.md`](../WP_AUDIT_2026-07-22.md).
- Architecture Decision Records explain decisions and their consequences.
- Frontend/backend handbooks define current implementation conventions.
- Code is not allowed to quietly contradict any of the above. If reality changes, update the document in the same pull request.

## Current delivery target

Build one audited vertical slice before broad CRUD coverage:

`participant -> booking -> payment ledger -> event/table assignment -> attendance -> feedback`

Safety, consent and audit are part of that slice, not a mythical “hardening phase” after launch.
