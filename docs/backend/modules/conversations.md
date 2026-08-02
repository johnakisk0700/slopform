# Conversation threads

Status: schema v1 for the admin Assistant. Schema-v2 post-event feedback
documents share the same MongoDB collection but live in the
[post-event feedback module](post-event-feedback.md#schema-v2--post-event-feedback-conversation).

## Purpose and authority

`modules/conversations` owns the schema-v1 MongoDB aggregate used by the admin
Assistant. MongoDB is authoritative for owner-scoped thread metadata, ordered
content and user-visible conversation state. PostgreSQL continues to own
business/audit/outbox/delivery guarantees; provider payloads do not become this
model.

The current Assistant keeps a PostgreSQL execution projection for request
idempotency, attempt fencing, stale-job recovery and queue correlation. Its
content columns are a compatibility/backfill projection, not the read source
for the API or model history.

This module also keeps the shared collection name
(`CONVERSATION_THREAD_COLLECTION`) and the shared persistence error types that
both aggregates use.

## Schema versions coexist

Both aggregates share `conversation_threads` and are discriminated by
`schemaVersion` **and** `purpose`. Neither reader touches the other's
documents: every v1 query pins `schemaVersion` implicitly through its
`admin_assistant` purpose filter, and every v2 query filters
`schemaVersion: 2, purpose: "post_event_feedback"`. No v1 document is
reinterpreted, migrated or rewritten by this module.

| Version | Purpose               | Owning module / repository                               | Shape                                                  |
| ------- | --------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| 1       | `admin_assistant`     | `conversations` / `ConversationThreadRepository`         | Generic thread: turns, goals, `state`, `humanTakeover` |
| 2       | `post_event_feedback` | `post-event-feedback` / `FeedbackConversationRepository` | Feedback conversation: messages, lifecycle × control   |

Schema v1 still validates a `post_event_feedback` purpose because that branch
was written before v2 existed. Nothing writes it: post-event feedback
conversations are created only as schema-v2 documents in the
[post-event feedback module](post-event-feedback.md#schema-v2--post-event-feedback-conversation).
Removing that legacy branch requires the usual versioned change, not a silent
edit.

## Schema v1 — assistant aggregate

Every v1 document has a UUID string `_id`, schema version, purpose, channel,
owner, title, lifecycle state, at most ten ordered goals, human-takeover state,
ordered turns and timestamps.

Goals have a stable key, contiguous ordinal, prompt, status and nullable
answer. Only an answered goal may contain an answer. Human takeover records
inactive/requested/active/resolved state and ordered timestamps. An active
takeover requires the thread's `human_takeover` state.

Turns have unique UUIDs and contiguous sequence numbers. A turn stores input,
optional output or safe error, model metadata when applicable — including the
service tier it ran under — exact attempt and lifecycle timestamps, plus
optional `partial` and `reasoning` while the turn is in flight. Those two are
nullable and defaulted so an older document still parses.

A terminal result is exclusive: succeeded has output, failed has error, and
nonterminal turns have neither. The v1 schema additionally rejects a settled
turn that still carries `partial`, so in-flight text cannot survive into a
terminal record. Note the asymmetry with the API schema, which checks both
`partial` and `reasoning` — the document schema checks only `partial`.

The aggregate embeds at most 75 turns to stay below MongoDB's hard BSON limit
under worst-case content sizes. A later retention/rollover design must preserve
owner scoping and global order before increasing that limit.

## Assistant synchronization and recovery

New Assistant work commits its PostgreSQL execution projection, then
materializes the Mongo conversation before queue insertion. A replay that finds
the PostgreSQL row but a missing Mongo turn materializes it and performs the
same deterministic enqueue, closing the transient cross-store gap.

After materialization:

- API thread/turn/list reads and worker model history come from MongoDB —
  history is rebuilt from settled user/assistant text only, so tool calls and
  their results are never replayed into a later turn;
- request replay, list inventory, worker start and stale recovery use
  PostgreSQL snapshots to backfill a missing thread/turn; a detail read also
  materializes a missing aggregate before returning it, and backfill never
  replaces existing Mongo result/content;
- terminal generation writes MongoDB first, then advances the PostgreSQL
  projection;
- worker start and terminal-result conflict recovery repair a lagging
  PostgreSQL terminal projection from MongoDB;
- stale recovery materializes a missing Mongo turn before failing it and
  isolates per-turn persistence failures so one row cannot starve the batch;
- retry eligibility is validated in PostgreSQL before Mongo state changes, so
  rejecting a non-latest retry cannot corrupt the conversation; an interrupted
  retry reconciles a queued PostgreSQL attempt with the preceding failed Mongo
  attempt before enqueue or terminal recovery.

There is no fictional cross-database transaction. Deterministic queue ids and
replay repair narrow gaps, while the existing database-to-queue crash gap
remains documented in the Assistant/queue contracts. A critical participant
delivery workflow must use the PostgreSQL outbox rather than pretending a Mongo
write also delivered a message.

## Tests and sources

Schema-v1 tests cover purpose/channel/owner rules, ten-goal bounds, ordered
goals/turns, takeover consistency, BSON-safe capacity, owner-scoped
synchronization, attempt-fenced transitions, conflicting terminal results,
oversized output and Assistant cross-store fault paths. Capacity is rechecked
inside PostgreSQL's locked sequence allocation, not trusted to the earlier Mongo
read. No test requires a live MongoDB.

- Schema v1:
  [schemas](../../../apps/backend/src/modules/conversations/conversation-thread.schemas.ts),
  [repository](../../../apps/backend/src/modules/conversations/conversation-thread.repository.ts)
- Schema v2 lives in the
  [post-event feedback module](post-event-feedback.md#schema-v2--post-event-feedback-conversation)
- [MongoDB lifecycle](../mechanisms/mongodb.md),
  [Assistant module](assistant.md) and
  [post-event feedback contract](post-event-feedback.md)
- [ADR 0007](../../decisions/0007-mongodb-conversation-authority.md),
  [ADR 0008](../../decisions/0008-post-event-feedback-conversations.md) and
  [implementation plan §6](../../history/post-event-feedback-plan-2026-07-25.md)
