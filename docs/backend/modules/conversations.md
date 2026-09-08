# Conversation threads

Status: schema v1 for the admin Assistant. Campaign feedback conversations are
PostgreSQL rows
([ADR 0015](../../decisions/0015-postgresql-feedback-conversations.md));
their in-memory aggregate still lives in the
[post-event feedback module](post-event-feedback.md#schema-v2--post-event-feedback-conversation).

## Purpose and authority

`modules/conversations` owns the schema-v1 MongoDB aggregate for the admin
Assistant. MongoDB is authoritative for owner-scoped thread metadata, ordered
content and user-visible state. PostgreSQL owns business/audit/outbox/delivery
guarantees and the Assistant's execution projection (idempotency, attempt
fencing, stale-job recovery, queue correlation). Projection content columns are
compatibility/backfill only — not the API or model-history read source.

This module also keeps the shared collection name
(`CONVERSATION_THREAD_COLLECTION`) and shared persistence error types. Feedback
runtime no longer reads that collection.

## Schema versions no longer share a runtime store

Both shapes historically shared `conversation_threads`, discriminated by
`schemaVersion` **and** `purpose`. Runtime readers are now split:

| Version | Purpose               | Authority                                     | Shape                                           |
| ------- | --------------------- | --------------------------------------------- | ----------------------------------------------- |
| 1       | `admin_assistant`     | `ConversationThreadRepository` / Mongo        | Turns, goals, `state`, `humanTakeover`          |
| 2       | `post_event_feedback` | `FeedbackConversationRepository` / PostgreSQL | Messages, lifecycle × control (feedback module) |

Leftover schema-v2 Mongo documents may remain until
`pnpm import:feedback-conversations`. They are not a runtime fallback. Schema
v1 still validates a `post_event_feedback` purpose from before v2 existed.
Nothing writes it. Removing that branch is a versioned change, not a silent
edit.

## Schema v1 — assistant aggregate

UUID string `_id`, schema version, purpose, channel, owner, title, lifecycle
state, ≤10 ordered goals, human-takeover state, ordered turns, timestamps.

- **Goals** — stable key, contiguous ordinal, prompt, status, nullable answer
  (answer only when answered).
- **Human takeover** — inactive/requested/active/resolved with ordered
  timestamps; active requires thread state `human_takeover`.
- **Turns** — unique UUIDs, contiguous sequence; input; optional output or safe
  error; model metadata (including service tier); attempt/lifecycle timestamps;
  nullable `partial` / `reasoning` while in flight (defaulted so older documents
  parse). Terminal result is exclusive: succeeded has output, failed has error,
  nonterminal has neither. The persisted document rejects a settled turn that still
  carries `partial`; reasoning is retained after settlement. Cap: 75 turns (BSON-safe under worst-case sizes). Retention/rollover
  must preserve owner scoping and global order before raising that limit.

## Assistant synchronization and recovery

New work: commit PostgreSQL execution projection → materialize Mongo conversation
→ enqueue. Replay that finds a PostgreSQL row but missing Mongo turn materializes
and enqueues deterministically.

After materialization:

- API and worker model history read MongoDB (settled user/assistant text only —
  tool calls are never replayed into a later turn).
- Request replay, list inventory, worker start and stale recovery use PostgreSQL
  snapshots to backfill a missing thread/turn; detail read also materializes
  before return; backfill never replaces existing Mongo result/content.
- Terminal generation writes MongoDB first, then advances PostgreSQL.
- Worker start and terminal-result conflict recovery repair a lagging PostgreSQL
  terminal projection from MongoDB.
- Stale recovery materializes a missing Mongo turn before failing it; per-turn
  persistence failures are isolated.
- Retry eligibility is validated in PostgreSQL before Mongo state changes;
  interrupted retry reconciles queued PostgreSQL with the preceding failed Mongo
  attempt before enqueue or terminal recovery.

No fictional cross-database transaction. Deterministic queue ids and replay
repair narrow gaps; the database-to-queue crash gap remains in the
Assistant/queue contracts. Critical participant delivery uses the PostgreSQL
outbox — never treat a Mongo write as delivery.

## Tests and sources

Schema-v1 tests cover purpose/channel/owner rules, ten-goal bounds, ordered
goals/turns, takeover consistency, BSON capacity, owner-scoped sync,
attempt-fenced transitions, conflicting terminals and
cross-store fault paths. The generation adapter bounds incoming provider output;
repository writes consume typed commands. Capacity is rechecked inside PostgreSQL's locked
sequence allocation. No live MongoDB required.

- Schema v1:
  [schemas](../../../apps/backend/src/modules/conversations/conversation-thread.schemas.ts),
  [repository](../../../apps/backend/src/modules/conversations/conversation-thread.repository.ts)
- Schema v2:
  [post-event feedback](post-event-feedback.md#schema-v2--post-event-feedback-conversation)
- [MongoDB lifecycle](../mechanisms/mongodb.md),
  [Assistant module](assistant.md),
  [post-event feedback](post-event-feedback.md)
- [ADR 0007](../../decisions/0007-mongodb-conversation-authority.md),
  [ADR 0008](../../decisions/0008-post-event-feedback-conversations.md),
  [ADR 0015](../../decisions/0015-postgresql-feedback-conversations.md)
