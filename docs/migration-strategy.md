# WordPress migration strategy

## Position

WordPress is a live prototype, migration source and possible temporary Viva
checkout host. It is not the canonical schema for the new application. Migrate
meaning, provenance and reconciliation state — not `wp_posts` / `wp_postmeta` /
serialized blobs one-for-one.

The runtime deploys no WordPress adapter and carries no WordPress URL or
credentials. Profile migration uses one-shot WXR/XML or versioned JSON
export/import. Add runtime configuration only with an adapter that validates and
consumes it; dormant secrets are not an integration strategy.

Factual source inventory:
[`evidence/wordpress-audit-2026-07-22.md`](evidence/wordpress-audit-2026-07-22.md).

## Sequence

1. **Freeze and export** — read-only dump/WP-CLI export and deployed Next.js
   source/configuration.
2. **Land raw snapshots** — source IDs, type, extraction timestamp and payload
   in restricted staging or encrypted artifacts.
3. **Reconcile** — dedupe identities; compare payment/order codes with Viva;
   classify live/trashed/test; resolve contradictory status.
4. **Transform** — versioned field mapping into target entities; record rejects;
   never silently coerce.
5. **Validate** — counts, money totals, status groups, sampled records;
   product/ops sign off exceptions.
6. **Cut over by capability** — one writer per fact during overlap.
7. **Retire** — remove WordPress credentials/adapters after rollback and
   retention windows expire.

## Preliminary mapping

| WordPress source             | Target                    | Treatment                                                        |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------- |
| WP user + `jts_profile` meta | Participant               | Normalize and validate; consent remains missing where absent     |
| `jts_payment` + `jts_paid`   | PaymentLedgerEntry        | Reconcile against Viva; never trust the flag or zero amount      |
| `jts_table` post fields      | Event + Venue + Table     | Split the conflated record; assign source provenance             |
| serialized `_jts_members`    | Booking + TableAssignment | Parse into staging, match identity, report incomplete rows       |
| `jts_feedback`               | Feedback                  | Add uniqueness/review/retention handling; restrict source tokens |
| send flags and SMTP logs     | Message/AuditEvent        | Import only defensible delivery evidence with provenance         |
| coupons                      | Promotion rules           | Validate semantics and expiry before recreating                  |

## Participant profile import v1

Operational CLI path (not an HTTP route). Canonical mapping, invariants and
commands: [participant module](backend/modules/participants.md).

1. Export `jts_profile` as WXR/XML (admin Tools > Export) or restricted JSON v1
   via [`export-jts-profiles.php`](../scripts/wordpress/export-jts-profiles.php).
2. `pnpm import:wordpress-profiles --file=<path>` (dry-run default; no DB).
3. Reconcile totals against WordPress; resolve rejects/conflicts.
4. Migrate, then `--apply`. Replay until every accepted row reports `unchanged`.

Real exports stay under ignored `secrets/wordpress/`; the repo has fake examples
only. Local 2026-07-23 inventory numbers are recorded on the participant page —
verified local run, not production cutover.

## Payment coexistence

Safe first boundary: browser redirect to WordPress-hosted checkout, then a
server-to-server signed result notification. Nest must independently verify the
provider transaction before recording a ledger entry. A browser return URL is
UX, not proof of payment.

Every checkout attempt needs a backend-created correlation ID. Unique external
order/transaction IDs; idempotent callbacks. If WordPress cannot provide a
trustworthy signed result, query Viva before marking settled.

## No 1:1 database clone

A clone would preserve the modelling defects we are replacing. Keep source IDs
and raw evidence for traceability; build target tables around product invariants.

## Required access before production migration

- Fresh WXR at cutover, or read-only database/WP-CLI access
- Viva transaction export/API for reconciliation
- Current Next.js repository and deployment configuration
- Confirmation whether `ebisu` is staging, pilot production or both
- Approved retention/consent rules and canonical status lifecycle
