# WordPress migration strategy

## Position

WordPress is a live prototype, migration source and possible temporary Viva checkout host. It is not the canonical schema for the new application. We migrate meaning, provenance and reconciliation state—not `wp_posts`, `wp_postmeta` and serialized blobs one-for-one.

The current foundation deploys no WordPress adapter and carries no WordPress
runtime URL or credentials. Add those configuration inputs only with the
adapter that validates and consumes them; dormant secrets are not an
integration strategy.

The factual source inventory is [`../WP_AUDIT_2026-07-22.md`](../WP_AUDIT_2026-07-22.md).

## Sequence

1. **Freeze and export** — obtain a read-only database dump/WP-CLI export and the deployed Next.js source/configuration.
2. **Land raw snapshots** — preserve source IDs, source type, extraction timestamp and source payload in restricted staging tables or encrypted artifacts.
3. **Reconcile** — deduplicate identities; compare payment/order codes with Viva; classify live, trashed and test records; resolve contradictory status.
4. **Transform** — map explicit fields into target entities through a versioned migration program. Record rejects; never silently coerce them.
5. **Validate** — compare counts, money totals, status groups and sampled records. Product/operations sign off exceptions.
6. **Cut over by capability** — new writes move one flow at a time. During overlap, choose one writer for every fact.
7. **Retire** — remove WordPress credentials and adapters only after rollback and retention windows expire.

## Preliminary mapping

| WordPress source             | Target                    | Treatment                                                        |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------- |
| WP user + `jts_profile` meta | Participant + Consent     | Normalize and validate; consent cannot be invented where absent  |
| `jts_payment` + `jts_paid`   | PaymentLedgerEntry        | Reconcile against Viva; never trust the flag or zero amount      |
| `jts_table` post fields      | Event + Venue + Table     | Split the conflated record; assign source provenance             |
| serialized `_jts_members`    | Booking + TableAssignment | Parse into staging, match identity, report incomplete rows       |
| `jts_feedback`               | Feedback                  | Add uniqueness/review/retention handling; restrict source tokens |
| send flags and SMTP logs     | Message/AuditEvent        | Import only defensible delivery evidence with provenance         |
| coupons                      | Promotion rules           | Validate semantics and expiry before recreating                  |

## Payment coexistence

The first safe boundary is a browser redirect to a WordPress-hosted checkout followed by a server-to-server, signed result notification. The Nest backend must independently verify the provider transaction before recording a payment ledger entry. A browser return URL is user experience, not proof of payment.

Every checkout attempt needs a correlation ID created by the new backend. Store external order/transaction IDs with a unique constraint and make callbacks idempotent. If WordPress cannot provide a trustworthy signed/verified result, query Viva directly before marking the ledger entry settled.

## No 1:1 database clone

A clone would preserve the exact modelling defects we are replacing: dynamic post meta, serialized member arrays, derived bookings and contradictory payment flags. Keep source IDs and raw evidence for traceability; build target tables around product invariants.

## Required access before production migration

- Read-only WordPress database dump or WP-CLI/SSH access
- Viva transaction export/API access for reconciliation
- Current Next.js repository and deployment configuration
- Confirmation whether `ebisu` is staging, pilot production or both
- Approved retention/consent rules and canonical status lifecycle
