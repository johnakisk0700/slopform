# ADR 0016: Outbound intent owns dispatch evidence

- Status: Accepted
- Date: 2026-09-06
- Scope: Feedback outbound authorization and operational logging. Supersedes
  ADR 0013's use of the outbound diagnostic log as dispatch evidence.

## Decision

Store immutable, versioned `dispatch_context` on each `message_outbox` row.
The enqueue contract names the message's purpose and supplies its required
evidence. Purpose, message kind and dedupe identity must agree. An ordinary AI
reply carries the original model snapshot's transcript and ingress boundary,
control generation, execution epoch, work revision and campaign resume
generation. A later locked read must never refresh that evidence.

The outbound intent service inserts the row and context together, using the
use-case service's transaction. Replaying a dedupe key returns the original
intent; it cannot replace evidence or revive a cancelled message. Transcript,
capacity, lifecycle and consent decisions stay with their existing owners.

Dispatch validates this contract and then applies current campaign, consent,
conversation and freshness guards. A purpose label cannot grant a terminal or
human-handoff exception: the current conversation must still identify that
exact outbox commitment. Unknown or malformed context cannot authorize a send.

`message_outbox_log` remains an append-only historical explanation, recorded in
the same transaction. The dispatcher never reads it for permission. HTTP
history remains available even when its historical evidence is insufficient
for a new send.

Runtime stage logs are observations. Their failure cannot change return
values, replace a business exception, roll back a transaction, choose retries
or authorize provider entry. Logs identify the operation, stage, outcome and
safe correlation identifiers; they contain no transcript, prompt or provider
body. They are neither the durable outbox nor the audit repository.

## Why

Previously, a missing diagnostic row or a different log origin could skip
ordinary-reply freshness checks. This made a historical projection part of
dispatch authority and let a producer omit a critical dependency. Keeping the
context on the intent makes that dependency explicit at insertion and dispatch.

The existing provider adapter, one-second sender poll, durable work revisions,
BullMQ wake-ups and maintenance recovery remain sufficient. This change needs
no event bus or second outbound queue.

## Cutover and failure behavior

Quiesce feedback HTTP and worker writers before migrating. Backfill recognized
purposes and candidate evidence from matching historical records once, without
reading current conversation state to manufacture missing evidence. Strict
runtime validation still applies to migrated candidates. Unusable legacy
context is never permission; safely pre-send unusable rows are cancelled with
an explicit reason. Preserve attempting, legacy sending, ambiguous and sent
outcomes. Uncertain delivery must never become an automatic retry.

Keep old writers stopped until the new binary starts. A rolling window with
old writers is unsupported. Follow the
[dispatch-context cutover](../deployment.md#feedback-dispatch-context-cutover);
the earlier conversation import remains a separate prerequisite when needed.

## References

- [State-driven orchestration](0013-state-driven-feedback-orchestration.md)
- [PostgreSQL feedback conversations](0015-postgresql-feedback-conversations.md)
- [Feedback module](../backend/modules/post-event-feedback.md)
- [Runtime logging](../backend/mechanisms/runtime-operations.md)
