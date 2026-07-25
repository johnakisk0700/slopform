# Conversation threads

Status: storage boundary implemented; WhatsApp workflow intentionally deferred.

## Purpose and authority

`modules/conversations` owns the MongoDB aggregate used by the admin Assistant
and future goal-driven participant conversations. MongoDB is authoritative for
owner-scoped thread metadata, ordered turns and user-visible conversation
state. PostgreSQL continues to own business/audit/outbox/delivery guarantees;
provider payloads do not become this model.

The current Assistant keeps a PostgreSQL execution projection for request
idempotency, attempt fencing, stale-job recovery and queue correlation. Its
content columns are a compatibility/backfill projection, not the read source
for the API or model history.

## Aggregate contract

Every document has a UUID string `_id`, schema version, purpose, channel,
owner, title, lifecycle state, at most ten ordered goals, human-takeover state,
ordered turns and timestamps.

| Purpose               | Required boundary                                     |
| --------------------- | ----------------------------------------------------- |
| `admin_assistant`     | admin channel, staff owner, no goals                  |
| `post_event_feedback` | WhatsApp channel, participant owner, one to ten goals |

Goals have a stable key, contiguous ordinal, prompt, status and nullable
answer. Only an answered goal may contain an answer. Human takeover records
inactive/requested/active/resolved state and ordered timestamps. An active
takeover requires the thread's `human_takeover` state.

Turns have unique UUIDs and contiguous sequence numbers. A turn stores input,
optional output or safe error, model metadata when applicable, exact attempt
and lifecycle timestamps. A terminal result is exclusive: succeeded has output,
failed has error, and nonterminal turns have neither.

The aggregate embeds at most 75 turns to stay below MongoDB's hard BSON limit
under worst-case content sizes. A later retention/rollover design must preserve
owner scoping and global order before increasing that limit.

## Assistant synchronization and recovery

New Assistant work commits its PostgreSQL execution projection, then
materializes the Mongo conversation before queue insertion. A replay that finds
the PostgreSQL row but a missing Mongo turn materializes it and performs the
same deterministic enqueue, closing the transient cross-store gap.

After materialization:

- API thread/turn/list reads and worker model history come from MongoDB;
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

## Future WhatsApp extension

The aggregate deliberately contains goal answers, conversation state and human
takeover state, but this change adds no Wasender send, webhook consumer,
participant identity mapping or workflow transitions. Those require separate
consent, audit, delivery/outbox and operator contracts. The transport adapter
must call a conversation application service; it must not write provider
payloads directly into MongoDB.

## Tests and sources

Tests cover purpose/channel/owner rules, ten-goal bounds, ordered goals/turns,
takeover consistency, BSON-safe capacity, owner-scoped synchronization,
attempt-fenced transitions, conflicting terminal results, oversized output and
Assistant cross-store fault paths. Capacity is rechecked inside PostgreSQL's
locked sequence allocation, not trusted to the earlier Mongo read.

- [Schemas](../../../apps/backend/src/modules/conversations/conversation-thread.schemas.ts),
  [repository](../../../apps/backend/src/modules/conversations/conversation-thread.repository.ts)
  and [Assistant service](../../../apps/backend/src/modules/assistant/assistant.service.ts)
- [MongoDB lifecycle](../mechanisms/mongodb.md) and
  [Assistant module](assistant.md)
