# ADR 0002: WordPress as a transitional boundary

- Status: Accepted for the migration phase
- Date: 2026-07-22
- Scope note: the PostgreSQL-only wording for new product capabilities is later
  narrowed for conversation aggregates by
  [ADR 0007](0007-mongodb-conversation-authority.md). The WordPress boundary is
  unchanged.

## Decision

Do not use WordPress as the canonical core or clone its tables. Keep it temporarily available as:

- a read-only migration source;
- a reference for copy and existing user journeys;
- optionally, the host of the existing Viva checkout while the new backend owns correlation, verification and its payment ledger.

All new product capabilities live in the Nuxt/Nest/PostgreSQL stack. Integration occurs through a narrow adapter with explicit contracts, timeouts, idempotency and audit.

## Consequences

- We avoid prematurely rebuilding a payment integration that currently limps across the finish line.
- We also avoid making WordPress post meta the permanent skeleton under a new admin skin.
- Coexistence requires one writer per fact and a documented cutover plan.
- WordPress credentials remain server-side and must be rotated out of source/config history.
- The foundation does not provision dormant WordPress credentials. A future
  adapter must introduce the minimum validated configuration and secret mounts
  alongside its contract and rotation procedure.

## Exit criteria

WordPress can be retired when migrated records are reconciled, the new intake and operational slice is live, payment verification/cutover is complete, and the rollback/retention window has elapsed.
