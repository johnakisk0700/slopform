# ADR 0007: MongoDB conversation authority

- Status: Accepted
- Date: 2026-07-25
- Scope: Conversation aggregates only; this narrows the PostgreSQL-only backend
  persistence boundary recorded in ADRs [0001](0001-platform.md),
  [0002](0002-wordpress-boundary.md) and [0006](0006-react-admin-runtime.md).

## Decision

Use MongoDB Community Server `8.0.28` through the MongoDB Node.js driver `7.5.0`
as the authoritative store for owner-scoped conversation aggregates. The
aggregate contains thread metadata, ordered turns, goal answers, lifecycle and
human-takeover state. Documents use an explicit schema version, runtime Zod
validation and reviewed indexes.

Keep the authority split narrow:

- MongoDB owns user-visible conversation content, order and conversation state.
- PostgreSQL owns relational business data, audit, outbox and delivery state.
  The Assistant keeps a PostgreSQL execution projection for request
  idempotency, sequence allocation, attempt fencing, queue correlation and
  stale-job recovery.
- Redis/BullMQ remains disposable coordination and carries identifiers, not
  conversation content.

MongoDB is a required dependency of the API and worker. Controllers and
provider adapters do not receive its client; the conversation repository owns
all collection access.

There is no cross-store transaction. Workflows must define one recovery
direction:

1. Assistant create/append commits the PostgreSQL execution projection.
2. It materializes the MongoDB turn.
3. It enqueues the deterministic BullMQ job.
4. Terminal generation writes MongoDB first, then advances PostgreSQL.
5. Replay, worker startup and stale recovery reconcile known gaps without
   treating either partial write as fictional atomicity.

Participant messaging remains outside this decision. A future Wasender
conversation workflow must persist delivery and audit through the PostgreSQL
outbox boundary; a MongoDB write is not proof that a message was delivered.

## Why

Conversation state is one owner-scoped aggregate that is normally read and
validated as a whole: ordered turns, bounded goals and takeover state evolve
together. A document boundary keeps those invariants and their future WhatsApp
extension in one persistence model instead of making the AI execution
projection the permanent product schema.

This does not mean PostgreSQL cannot store conversations. It can. MongoDB is
chosen narrowly to give conversation content an independent document lifecycle
and scaling boundary while PostgreSQL stays focused on transactional business,
audit and delivery guarantees. The benefit is accepted only for this aggregate;
it is not permission to route unrelated JSON-shaped data into a second database.

Embedded documents are capped at 75 turns so worst-case validated content stays
below MongoDB's 16 MiB BSON limit. Rollover or archival requires a separate,
tested decision before that bound can increase.

## Consequences

- The system now operates and backs up two authoritative databases. Production
  needs separate credentials, readiness, disk/capacity monitoring, encrypted
  paired backups, restore drills and cross-store reconciliation.
- API and worker availability now depends on MongoDB. PostgreSQL content columns
  may backfill a missing conversation during the transition, but they are not an
  alternate read authority after materialization.
- Cross-store workflows have recoverable gaps. Deterministic job IDs and
  compare-and-set transitions narrow them; they do not provide exactly-once
  execution or distributed transactions.
- MongoDB schema evolution must be versioned and deployed with compatible
  readers/writers plus an explicit backfill or migration path. Silently
  reinterpreting old documents is not allowed.
- Conversation retention, rollover and deletion remain product decisions.
  Adding a second copy or indefinite retention is not an acceptable substitute
  for defining them.
- The operational cost must be revisited if conversation volume and access
  patterns no longer justify a dedicated store.

## Licensing

MongoDB Community Server versions released after 2018, including the selected
8.0 line, use the Server Side Public License (SSPL) v1.0. The official Node.js
driver uses Apache License 2.0. Self-hosting Community Server as an internal
application database is the accepted deployment here; the license must be
reviewed again before offering MongoDB functionality as a third-party service,
redistributing a database service, or changing the deployment model. A
commercial MongoDB license remains an alternative if organizational review
rejects SSPL.

This records the engineering constraint, not legal advice. See MongoDB's
[Community Server licensing page](https://www.mongodb.com/legal/licensing/community-edition),
[SSPL FAQ](https://www.mongodb.com/legal/licensing/server-side-public-license/faq)
and the Node driver
[Apache-2.0 license](https://github.com/mongodb/node-mongodb-native/blob/master/LICENSE.md).

## Rejected alternatives

### PostgreSQL-only conversations

Normalized tables or a versioned JSONB aggregate would preserve one operational
database and make Assistant projection/content updates transactional. This is
the strongest alternative and should be reconsidered if MongoDB's operational
or licensing cost outweighs the document boundary. It is rejected for the
current product direction because conversation content, goals and takeover
state are intentionally one independently evolving aggregate rather than an
extension of the relational execution projection.

### Equal dual authority

Keeping PostgreSQL and MongoDB as interchangeable conversation sources would
turn every disagreement into an undefined merge. PostgreSQL may temporarily
hold compatibility/backfill content, but MongoDB becomes authoritative once the
aggregate exists.

### Wasender as conversation history

Provider message logs are incomplete, configuration-dependent and external to
our retention and identity rules. Wasender remains a transport adapter, never
the conversation source of truth.

## References

- [MongoDB lifecycle](../backend/mechanisms/mongodb.md)
- [Conversation aggregate](../backend/modules/conversations.md)
- [Assistant cross-store recovery](../backend/modules/assistant.md)
- [Production deployment and paired backup](../deployment.md)
- [MongoDB Node.js driver compatibility](https://github.com/mongodb/node-mongodb-native#compatibility)
- [MongoDB document limits](https://www.mongodb.com/docs/manual/reference/limits/)
