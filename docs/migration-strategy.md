# WordPress migration strategy

## Position

WordPress is a live prototype, migration source and possible temporary Viva checkout host. It is not the canonical schema for the new application. We migrate meaning, provenance and reconciliation state—not `wp_posts`, `wp_postmeta` and serialized blobs one-for-one.

The runtime deploys no WordPress adapter and carries no WordPress URL or
credentials. Profile migration uses one-shot WXR/XML or versioned JSON
export/import paths instead of giving the application permanent access to the
legacy system.
Add runtime configuration only with an adapter that validates and consumes it;
dormant secrets are not an integration strategy.

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
| WP user + `jts_profile` meta | Participant               | Normalize and validate; consent remains missing where absent     |
| `jts_payment` + `jts_paid`   | PaymentLedgerEntry        | Reconcile against Viva; never trust the flag or zero amount      |
| `jts_table` post fields      | Event + Venue + Table     | Split the conflated record; assign source provenance             |
| serialized `_jts_members`    | Booking + TableAssignment | Parse into staging, match identity, report incomplete rows       |
| `jts_feedback`               | Feedback                  | Add uniqueness/review/retention handling; restrict source tokens |
| send flags and SMTP logs     | Message/AuditEvent        | Import only defensible delivery evidence with provenance         |
| coupons                      | Promotion rules           | Validate semantics and expiry before recreating                  |

## Participant profile import v1

The implemented profile path is intentionally operational rather than an HTTP
route:

1. Export `jts_profile` records from WordPress admin as WXR/XML, or run
   [`export-jts-profiles.php`](../scripts/wordpress/export-jts-profiles.php)
   through WP-CLI to produce restricted JSON v1. Both paths extract the seven
   deployed signup questions; the importer auto-detects the input format.
2. Run `pnpm import:wordpress-profiles --file=<path>` locally or in the approved
   migration environment. Dry-run validates and normalizes without connecting
   to PostgreSQL.
3. Reconcile total, eligible, trashed and rejected counts against WordPress.
4. Apply reviewed database migrations, then rerun with `--apply`. Each accepted
   source profile writes participant, interests, provenance and audit in one
   transaction.
5. Replay the same artifact and require every accepted row to report
   `unchanged`. Resolve all source-ID rejects and duplicate-email conflicts
   before sign-off.

The canonical mapping and operational controls are documented in the
[participant module](backend/modules/participants.md). Real exports are kept in
the ignored, permission-restricted `secrets/wordpress/` directory; the
repository contains only fake example data.

The 2026-07-23 WXR inventory contained 45 profiles: 36 active and 9 trashed. A
local PostgreSQL import accepted 32 active profiles (22 complete and 10
incomplete), wrote 137 interests plus 32 provenance and 32 audit rows, and
replayed all 32 as unchanged. Four active profiles remain blocked on invalid
non-empty phone values at source IDs `77`, `83`, `96` and `105`. This is a
verified local migration run, not evidence of a production database cutover.

## Payment coexistence

The first safe boundary is a browser redirect to a WordPress-hosted checkout followed by a server-to-server, signed result notification. The Nest backend must independently verify the provider transaction before recording a payment ledger entry. A browser return URL is user experience, not proof of payment.

Every checkout attempt needs a correlation ID created by the new backend. Store external order/transaction IDs with a unique constraint and make callbacks idempotent. If WordPress cannot provide a trustworthy signed/verified result, query Viva directly before marking the ledger entry settled.

## No 1:1 database clone

A clone would preserve the exact modelling defects we are replacing: dynamic post meta, serialized member arrays, derived bookings and contradictory payment flags. Keep source IDs and raw evidence for traceability; build target tables around product invariants.

## Required access before production migration

- A fresh WordPress WXR export at cutover, or read-only database/WP-CLI access
- Viva transaction export/API access for reconciliation
- Current Next.js repository and deployment configuration
- Confirmation whether `ebisu` is staging, pilot production or both
- Approved retention/consent rules and canonical status lifecycle
