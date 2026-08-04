# Database lifecycle and migrations

Status: implemented foundation. Last verified: **2026-08-02** against Drizzle
ORM `0.45.2`, Drizzle Kit `0.31.10`, `pg` `8.22.0` and PostgreSQL `18.4`.

## Boundary

`packages/database` owns schema, migrations and Drizzle client primitives. Each
Nest HTTP/worker process owns one normal lazy node-postgres pool through
`DatabaseService`. The feedback worker has one narrow exception: a separate
five-connection pool holds session advisory locks and never executes repository
queries. Services choose transaction scope; repositories issue explicit queries
on the supplied transaction or service handle. Conversation aggregates are
outside this boundary; see [MongoDB lifecycle](mongodb.md).

```mermaid
flowchart LR
  Service["Domain service"] -->|"opens transaction"| Database["DatabaseService"]
  Service -->|"passes transaction"| Repository["Domain repository"]
  Repository --> Database
  Database -->|"normal pool per process"| PostgreSQL[(PostgreSQL)]
  FeedbackLock["Feedback materialization lock pool"] -->|"session advisory locks only"| PostgreSQL
  Migrator["One-shot migrator"] -->|"reviewed forward SQL"| PostgreSQL
```

Do not create pools in repositories, expose Drizzle to controllers or bury
transaction ownership inside a generic repository.

## Pool and readiness

| Policy                   | Bound                             |
| ------------------------ | --------------------------------- |
| Maximum connections      | `DATABASE_POOL_MAX`, default `10` |
| Connection/pool checkout | 2 seconds                         |
| PostgreSQL statement     | 15 seconds                        |
| Driver response          | 16 seconds                        |
| Idle transaction         | 30 seconds                        |
| Readiness                | 1 second                          |

The driver bound is longer than the statement timeout so the server can cancel
first. Longer work needs an explicit operational path. Readiness runs
`select 1`; concurrent probes share one in-flight query and the shared deadline
in `infrastructure/readiness.ts`. A pass proves only that this process can
execute a query now.

The pool logs idle-client failures as `database.pool.error`. Nest shutdown calls
`pool.end()` and detaches that listener even when closing fails. Deployment
grace must exceed bounded active work.

## Schema invariants

Application tables live in PostgreSQL `public`; Drizzle's journal lives at
`drizzle.__drizzle_migrations`. TypeScript uses camel case; persisted names are
explicit snake case. Prefer database-generated UUID/timestamp defaults, bounded
non-blank text, JSON shape checks and indexes for measured composite lookups.

**Assistant.** `assistant_threads` / `assistant_turns` retain the execution and
idempotency projection (replay, attempt fencing, stale-job recovery, queue
correlation). Content fields are a compatibility/backfill projection; MongoDB
is authoritative for user-visible content and ordered history. Composite
ownership FKs, owner-scoped request-id uniqueness and one-active-turn partial
uniqueness keep HTTP replay coherent. Terminal writes are conditional on
nonterminal status and the current attempt. The first generated turn of an
immutable branch carries paired nullable
`branched_from_thread_id` / `branched_from_turn_id`. The source thread is
`ON DELETE RESTRICT`; the turn id has no PostgreSQL FK (branch-of-branch may
reference a turn inherited inside the source MongoDB aggregate). Inherited turns
are not copied into PostgreSQL.

**Participants, events, email.** Detailed contracts live in
[participants](../modules/participants.md), [events](../modules/events.md) and
[email delivery](../modules/email-delivery.md). Event venue is flat nullable
columns on `events` (no venue table): complete core shape when present, provider
`google` only, `venue_context_revision` defaults to `0`, creation with a venue
stores `1`, and every later explicit venue replacement or clear increments it in
the same SQL update. Venue audits may retain flags and revision, never label,
place id or address-like text.

**Post-event feedback.** Persistence spans `feedback_campaigns`,
`feedback_campaign_summaries`, `feedback_answers`,
`feedback_answer_withdrawals`, `feedback_notes`, `provider_message_ingress`,
`feedback_conversation_executions`, `feedback_maintenance_checkpoints`,
`message_outbox` and `message_outbox_log`. One campaign per event; answer
uniqueness uses `NULLS NOT DISTINCT`; ingress dedupes on
`(chat_jid, provider_message_id)`; outbox `dedupe_key` is unique. Participant
and campaign FKs are `ON DELETE RESTRICT` with no references to
`event_attendees`. A withdrawn answer is hard-deleted and leaves a tombstone on
the same uniqueness key. See
[post-event feedback](../modules/post-event-feedback.md).

Cross-store and fencing invariants agents must not break:

- Campaign resume intent: monotonic `resume_generation`, acknowledged
  `resume_applied_generation`, and a due timestamp exactly while they differ.
  Maintenance allocates `(resume_due_at, campaign_id, generation)` behind its
  checkpoint, commits, then re-locks that exact generation `FOR UPDATE` across
  MongoDB admission and PostgreSQL acknowledgement. Redis is not part of this
  proof.
- `feedback_conversation_executions` holds monotonic epoch/work revision and
  nullable lease token/expiry so a stale worker cannot commit relational
  extraction effects. MongoDB still owns lifecycle and durable due work.
- Maintenance checkpoints: `conversation_due`, `ingress_pending`,
  `summary_pending`, `campaign_resume`, `summary_auto`. A task row is locked
  `FOR UPDATE` only while one page is allocated; processing happens after
  commit. These rows never mean work completed.
- Direct dispatch extends `message_outbox` with claim token/expiry,
  `send_started_at`, attempt count and bounded last error. Only `claimed`
  returns to the claim query on lease expiry; `attempting` expiry becomes
  `ambiguous`. Unknown provider outcomes never return to `pending`.
- `provider_message_ingress.ingress_order` is a sequence assigned at insert — the
  cross-process FIFO authority for one conversation. All observations take the
  same transaction-scoped routing advisory lock before sequence allocation.
  Materialization holds a dedicated session-scoped advisory lock from the
  worker-only five-connection pool across PostgreSQL/MongoDB work.
- Email intent creation, outbox publication and admin audit share one
  transaction. Message content and raw recipient stay in the intent table.
- Domain mutation and `audit_events` share one transaction when audit is
  required. Runtime logs do not replace durable audit.

## Migration contract

The TypeScript schema is the source of truth; reviewed SQL is the deployment
artifact.

```bash
pnpm --filter @join-the-six/database db:generate --name=<meaningful_name>
pnpm --filter @join-the-six/database db:check
pnpm --filter @join-the-six/database db:migrate
```

`db:generate` and `db:check` need no database; `db:migrate` does. `db:check`
validates migration history, not ungenerated schema drift — regenerate and expect
no further change before review.

Run one migrator before application rollout. Never edit an applied migration,
run parallel migrators or use `drizzle-kit push` on shared/staging/production
data. Review generated SQL for locks, rewrites, defaults, backfills and
destructive statements. Prefer expand/backfill/contract across releases when a
change cannot finish safely in one deploy window. Recovery is normally a
reviewed forward migration.

Feedback orchestration migrations are reader-first: nullable dispatch fields,
execution-fence table, summary epoch/claim fields and expanded status checks
land before new worker writers. V1 `sending` rows remain valid during the bridge.
The two initial assistant migrations are an unshipped same-release supersession;
the second aborts if temporary `assistant_runs` contains any row. That narrow
pre-release case does not authorize editing migrations after shared rollout.

## Test data, tests and operations

No global seed command until a repeatable dataset exists. Tests create
deterministic fixtures in an isolated database and clean with rollback or
exact-key deletion.

- Unit tests: client defaults, lifecycle, readiness coalescing, timeout.
- Database package tests include `drizzle-kit check`.
- Before release, apply migrations twice to disposable PostgreSQL and verify
  constraints (not yet automated in-repo).
- Monitor pool `totalCount`, `idleCount` and `waitingCount` before changing pool
  size; every API and worker replica has its own pool.

## Sources and official references

- [Database client](../../../packages/database/src/client.ts),
  [Nest adapter](../../../apps/backend/src/infrastructure/database/database.service.ts),
  [readiness](../../../apps/backend/src/infrastructure/readiness.ts),
  [schema](../../../packages/database/src/schema/index.ts),
  [migrations](../../../packages/database/drizzle/)
- [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql),
  [migrations](https://orm.drizzle.team/docs/migrations),
  [node-postgres pooling](https://node-postgres.com/features/pooling)
