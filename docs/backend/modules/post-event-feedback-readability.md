# Feedback code readability

Guidance for the whole feedback mechanism: campaigns, ingress, matching,
extraction, delivery, reconciliation, staff actions, summaries and persistence.
An individual function or command is an example, not a predetermined refactoring
priority. The [module](post-event-feedback.md),
[scenarios](post-event-feedback-scenarios.md) and
[ADR 0015](../../decisions/0015-postgresql-feedback-conversations.md) remain
true behavior and storage contracts.

## Responsibilities a reader can recognize

| Responsibility               | Owns                                                                      | Example                                                                  |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| HTTP / job / webhook adapter | Transport validation and invoking an application operation                | Launch a campaign; process an ingress id                                 |
| Use-case service             | A complete business operation, ordering, transaction and failure handling | Resume a campaign; accept staff takeover; materialize an inbound message |
| Domain mechanism             | A named decision or coherent protocol with explicit inputs and outcomes   | Delivery-status progression; name resolution; next-action planning       |
| PostgreSQL repository        | Explicit queries, projections, constraints and row locks                  | Find a campaign; claim an outbound row; update conversation work         |
| Provider adapter             | External client behavior and provider-specific outcomes                   | WhatsApp transport; model generation                                     |

These are responsibilities, not a requirement for five new directory trees.
Keep the existing feature folders. One method may already express a complete
use case; one pure function may already encapsulate a mechanism. Preserve good
boundaries and focus edits on mixed responsibilities or duplicated rules.

A reader should be able to follow the business operation without reading SQL,
provider payloads or a repeated decision algorithm. Opening the implementation
should reveal its effects, preconditions and failure behavior. Names alone do
not establish that boundary.

## Repositories around PostgreSQL

Application code calls a domain repository instead of building Drizzle queries.
The repository owns SQL, mapping and efficient projections; it does not send
WhatsApp messages, generate AI text, notify staff or start a campaign workflow.
Controllers and processors receive the application result, not a database client.

Keep explicit transaction parameters for related writes. Named queries such as
`findCampaignByIdForUpdate` explain their locking contract. Conditional updates,
uniqueness and compare-and-set predicates remain in repositories where the
actual database guarantee is enforced. Do not replace them with an earlier
unlocked application read.

Use concrete repositories for real data boundaries. A generic `BaseRepository`,
a repository per method or several independent owners for the same conversation
aggregate would add navigation without clarifying ownership.

## Transactions hidden from the entry flow

A controller or higher-level workflow can read like this:

```ts
return this.campaignService.resume(campaignId, actorId, requestId);
```

The service behind that operation owns the transaction. The current
[`transitionStatus`](../../../apps/backend/src/modules/post-event-feedback/campaign/campaign.service.ts)
is a concrete reference. Its structure, with details omitted, is:

```text
resume campaign
  -> one service transaction
       lock and validate the campaign
       change status and resume generation
       revise conversation due work
       append audit
  -> commit
  -> publish wake-ups; durable work supports recovery
```

The caller does not pass a transaction. Inside the use case, repositories and
audit receive the same explicit `tx`. This keeps the entry flow readable and
preserves one atomic operation across several tables.

Do not hide a separate transaction inside each repository method: campaign
status, conversation work and audit could then commit separately. Avoid implicit
transaction contexts or decorators introduced merely to hide the parameter.
A dedicated service is useful when it owns a complete operation; a wrapper
around every `database.transaction` call is not automatically an improvement.

Transaction size follows the business guarantee. Campaign launch keeps one
transaction per respondent so a conflicting phone does not abort other launches.
Model and WhatsApp calls remain outside short database transactions. A rollback
followed by a human brake remains two distinct operations. Preserve each
operation's current lock order and post-commit recovery.

## Functions and dedicated classes for mechanisms

Choose a pure function for a decision that depends only on supplied values.
Choose a dedicated class when a mechanism has meaningful dependencies,
configuration or a coherent protocol. It should expose domain operations and
hide its internal details. Neither choice requires a `Helper` suffix.

Existing examples already show the intended style:

```ts
const status = coalesceDeliveryStatus(currentStatus, incomingStatus);
const stopped = matchesPostEventFeedbackStopCommand(message.text);
const plan = deriveFeedbackConversationReconciliationPlan({
  conversation,
  campaignStatus,
  consentGranted,
  now,
  policy,
});
```

These are three independent examples, not a proposed pipeline. They live in
[delivery-status](../../../apps/backend/src/modules/post-event-feedback/outbox/delivery-status.ts),
[stop-command](../../../apps/backend/src/modules/post-event-feedback/matching/stop-command.ts)
and [planner](../../../apps/backend/src/modules/post-event-feedback/reconciliation/planner.ts).
Reuse them instead of creating alternative implementations. STOP is an example
of an existing mechanism; this guide does not request new detection behavior.

A richer mechanism can return a domain result such as `idle`, `wait`, `remind`
or `expire` with the evidence needed by its caller. The caller owns execution.
Keep meaningful distinctions between supersession, claim loss, invalid state,
capacity and provider uncertainty. A generic boolean or swallowed exception
would erase information needed for correct handling.

[FeedbackTransport](../../../apps/backend/src/modules/post-event-feedback/outbox/transport.ts)
is a useful class/adapter boundary: the dispatcher uses `sendText` and receives
`accepted`, `not-accepted` or `unknown`. Provider internals stay behind that
contract; the dispatcher retains the decision about retry and durable delivery.

Pure state transitions follow the same principle. Supplied state and time go
in; a proposed next state and whether it changed come out. Queries, serialization,
locks and writes remain with the owning persistence/application code. Do not
introduce another copy of the business state to make a split easier.

## What the resulting code should look like

- Public operations read as business actions with visible early exits and
  failure outcomes. A cohesive operation may use named private methods before
  it needs another injectable service.
- Inputs and outputs use existing domain types and named, readonly fields.
  Avoid positional boolean lists, shared mutable context bags and broadly typed
  objects that let every phase modify everything.
- A method moves when its new owner explains why those statements belong
  together. Moving a large block into `processEverything()` or making a class
  for every condition does not meet this test.
- A reviewer can identify the one transaction owner, all participating writes
  and the first external side effect. Necessary guards stay visible at the
  boundary they protect.
- Comments explain a constraint or decision that the code cannot express.
  For example, “campaign resume updates these rows without the conversation
  mutex” explains a row lock; “load the conversation” repeats the next line.
  Extended rationale belongs in the module docs.
- File length is a signal to inspect, not a target. A long cohesive SQL adapter
  can be reasonable. A short file that hides ordering through many unrelated
  helpers can still be hard to understand.

## Scope and agent organization

Use the current verified commit as each batch's checkpoint. Select work from
the whole mechanism: existing responsibilities, usable mechanisms, mixed
responsibilities and real callers. Include areas that should stay as they are.
Do not repeat a completed batch or select work solely from an example above.

Codex owns this guide and the architecture decisions. Before assigning bulk
implementation, specify for each selected operation:

1. The concrete reading problem and an example of its intended caller.
2. Its owner, typed inputs, outcomes, effects and transaction boundary.
3. The exact files owned by that Grok and shared files owned by the coordinator.
4. Existing behavior and focused scenarios that must remain true.

A Grok implementer owns the complete slice, its focused checks and corrections.
A Grok reviewer checks the finished diff against this guide; findings return to
the implementer. Codex reviews the proposed interfaces and critical boundaries,
then integrates. Independent slices can run in parallel when file and dependency
ownership actually permit it. Review only the new diff against the checkpoint.

Preserve existing questionnaire, prompt, classification, hostility/profanity,
STOP, consent and retry behavior. Preserve transactions, idempotency, lock order,
execution fencing, terminal outbox identity, ambiguous outcomes and capacity
recovery. Schema, HTTP contracts, Assistant storage and live data are outside
this readability pass. Report concrete defects separately before mixing behavior
changes into a structural diff.

Handoffs contain files changed, the resulting public flow, checks actually run
and unresolved findings. Reuse these notes instead of repeating a whole-module
exploration for every correction. Keep existing behavioral tests for pure moves;
add tests for uncovered risks rather than filenames or implementation-shaped mocks.
Adapter semantics use an explicitly disposable database, not mocked Drizzle chains.

Run the relevant focused scenarios while implementing and `pnpm check` after
integration. Both typecheck and build matter. Accept a slice when ownership is
clearer, behavior is preserved, dependencies are coherent and code, docs and tests
agree. A lower line count alone is insufficient.
