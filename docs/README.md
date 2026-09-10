# Project documentation

Read the page that owns your change; repository and area `AGENTS.md` files map
common tasks. Source, tests and configuration are operational truth. Update
current docs when a boundary changes; accepted ADRs remain historical records.

## Current work and conventions

- [Portfolio plan](portfolio-plan.md) — product decisions and next bounded work
- [Code readability](code-readability.md) — direct operations and justified abstractions
- [Showcase scenarios](showcase-scenarios.md) — workshop story and synthetic campaign plan
- [Resend follow-up](tasks/resend-email.md) — remaining email setup and verification
- [Documentation standard](documentation-standard.md)

## Implementation guides

- [Architecture](architecture.md) and [WordPress migration](migration-strategy.md)
- [Backend](backend.md), [mechanisms](backend/mechanisms/README.md), [modules](backend/modules/README.md)
- [Frontend](frontend.md) and [component inventory](frontend/components/README.md)
- [Admin style guide](../apps/admin/README.md) — canonical colors, spacing, type and themes
- [Theming pointer](frontend/theming.md), [cookbook](frontend/admin-cookbook.md)
- [Assistant screen](frontend/assistant.md), [feedback inbox](frontend/feedback-conversations.md), [outbound queue](frontend/feedback-outbound-queue.md)
- [Harness workspace](../harness/README.md) — local tools, fixtures and behavioral scenarios
- [Deployment](deployment.md)

## Decisions

Accepted records are immutable; superseding ADRs and current area guides describe
the present implementation. Retired source and archive paths remain recoverable
through Git history.

- [ADR 0001: TypeScript modular-monolith platform](decisions/0001-platform.md)
- [ADR 0002: WordPress as a transitional boundary](decisions/0002-wordpress-boundary.md)
- [ADR 0003: Nuxt rendering by route family](decisions/0003-rendering.md)
- [ADR 0004: Admin-only Nuxt application boundary](decisions/0004-admin-only-boundary.md)
- [ADR 0005: Design tokens and class-based light/dark theming](decisions/0005-theming-and-dark-mode.md)
- [ADR 0006: React admin runtime](decisions/0006-react-admin-runtime.md)
- [ADR 0007: MongoDB conversation authority](decisions/0007-mongodb-conversation-authority.md)
- [ADR 0008: Post-event feedback conversations](decisions/0008-post-event-feedback-conversations.md)
- [ADR 0009: Generated admin API client](decisions/0009-generated-api-client.md)
- [ADR 0010: Generated admin client is not committed](decisions/0010-generated-client-not-committed.md)
- [ADR 0011: Commissioner for display, Sora for the wordmark](decisions/0011-display-typeface.md)
- [ADR 0012: Selectable palettes as a second appearance axis](decisions/0012-selectable-palettes.md)
- [ADR 0013: State-driven post-event feedback orchestration](decisions/0013-state-driven-feedback-orchestration.md)
- [ADR 0014: Public Slopform identity and remaining compatibility IDs](decisions/0014-public-slopform-identity.md)
- [ADR 0015: PostgreSQL owns feedback conversations](decisions/0015-postgresql-feedback-conversations.md)
- [ADR 0016: Outbound intent owns dispatch evidence](decisions/0016-feedback-dispatch-context.md)
- [ADR 0017: Effect utilities for local workflow composition](decisions/0017-effect-for-local-workflows.md)
- [ADR 0018: Bounded campaign topic analysis with PostgreSQL and a Python subprocess](decisions/0018-campaign-topic-analysis.md)
- [ADR 0019: Application logging and nginx request logs](decisions/0019-application-logging.md)
- [ADR 0020: Use async functions for serial workflows](decisions/0020-effect-for-resource-scopes.md)
- [ADR 0021: BullMQ schedules PostgreSQL outbox batches](decisions/0021-bullmq-outbox-polling.md)
- [ADR 0022: Admin visual language](decisions/0022-admin-visual-language.md)

## Verification

Root [package.json](../package.json) owns public commands; [turbo.json](../turbo.json)
owns task ordering and cache inputs. Setup and full `pnpm check` instructions are
in the [repository README](../README.md).

`pnpm docs:check` verifies local Markdown links, inline source paths, Mermaid
fences and orphaned docs. Accepted ADRs may name deleted source and retired
`docs/history/` or `docs/evidence/` records; their links to current documentation
still resolve. Live docs receive all checks. Anchor fragments are not checked.
