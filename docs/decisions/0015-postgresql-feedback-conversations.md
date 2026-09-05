# ADR 0015: PostgreSQL owns feedback conversations

- Status: Accepted
- Date: 2026-09-05
- Scope: Campaign feedback conversations and their transaction boundaries.
  Supersedes the feedback storage consequences of ADRs 0007, 0008 and 0013.
  The admin Assistant retains its MongoDB conversation authority.

## Decision

Store each feedback conversation in one PostgreSQL `feedback_conversations`
row. Routing, lifecycle, control and durable scheduling use constrained scalar
columns. The bounded transcript, questionnaire goals, attention evidence and
usage accounting use JSONB. Do not also store a complete copy of the aggregate
beside those columns.

A small persistence adapter preserves the existing typed aggregate and HTTP
views. PostgreSQL is the only runtime source for feedback conversations.
MongoDB continues to own the separate admin Assistant threads.

Services own short, explicit transactions. Repositories use the transaction
provided by the service. Related feedback effects commit together:

- Creating a respondent's conversation, intro, transcript entry and audit.
- Recording an inbound message, its next work revision and ingress completion.
- Applying STOP, withdrawing consent, cancelling pending automation and
  recording the acknowledgement.
- Writing extraction results, outbound intent and transcript, goals, attention
  and the consumed cursor or terminal state.
- Changing campaign or staff control and the corresponding work or outbox state.

Campaign launch retains one transaction per respondent so a conflicting phone
does not prevent other eligible respondents from receiving their introduction.

## Concurrency and recovery

Model calls and WhatsApp sends remain outside database transactions. The
execution lease retains its epoch and token in
`feedback_conversation_executions`; no second epoch is stored on the
conversation. The campaign resume generation remains a control token for
immutable outbound decisions. Its separate acknowledgement and repair protocol
are unnecessary once resume and conversation scheduling commit together.

BullMQ remains a disposable wake-up mechanism. Conversation revisions and due
timestamps remain durable, and maintenance can recreate a missing wake-up.
Per-route ingress ordering, execution fencing, consent checks and final send
guards remain necessary across worker replicas and external calls.

An uncertain WhatsApp result remains `ambiguous` and is not automatically
resent. A database transaction cannot establish whether an external provider
accepted a request before a connection or process failed.

## Why

Feedback conversations are bounded questionnaires whose state changes together
with relational answers, campaign control, consent, audit and outbound intent.
Co-locating those facts removes cross-database recovery work from ordinary
participant interactions.

JSONB keeps the small, ordered transcript and versioned questionnaire structure
together. Scalar columns support constraints, work scheduling and compact admin
queries. This avoids both a second state authority and a MongoDB query-language
adapter implemented over SQL.

## Cutover

Stop feedback writers, apply the migration, then validate and import existing
schema-v2 MongoDB feedback documents while preserving identities, message order,
accepted results and accounting. Import
must reject conflicting destination data and must not delete source documents.
Restore missing schedules and unfinished legacy handoffs during import.
Maintenance recreates pending wake-ups from the imported durable state when
workers resume; verify recovery before reopening feedback HTTP traffic.

Runtime fallback to MongoDB and dual writes are excluded. Existing Assistant
documents and their recovery protocol are outside this migration. Old applied
SQL migrations remain immutable; new constraints on existing feedback tables
must account for the import order.

## References

- [MongoDB conversation authority](0007-mongodb-conversation-authority.md)
- [Feedback product contract](0008-post-event-feedback-conversations.md)
- [State-driven orchestration](0013-state-driven-feedback-orchestration.md)
- [Feedback module](../backend/modules/post-event-feedback.md)
- [Database mechanism](../backend/mechanisms/database.md)
