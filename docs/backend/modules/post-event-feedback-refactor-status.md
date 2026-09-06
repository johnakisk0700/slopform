# Feedback refactor status

Last updated: **2026-09-06**. This is the current progress and next-work map.
Update it at each checkpoint; confirm Git status before resuming. Completed
rows are records of finished work, not instructions to repeat it.

## Where we are

**The AI extraction flow has been split into cohesive mechanisms. The next
production flow is ingress materialization. The whole module is not finished.**

Last committed and pushed checkpoint: `5769b5b` (dispatch evidence and
observational logging). Three completed passes remain in the working tree:
AI flow / Effect utilities, deferred-test relocation, and neighboring types.
No implementation batch is running. Save a reviewed Git checkpoint before
starting the next production slice.

## Completed

| Work                                     | Result                                                                                                                                                                                    | Checkpoint             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Conversation storage                     | Campaign feedback conversations use PostgreSQL; Assistant threads retain MongoDB. Feedback no longer needs the former cross-database conversation sync.                                   | `3af4d43`; ADR 0015    |
| Persistence and orchestration boundaries | Explicit repositories and service-owned transactions; execution fencing, turn decisions and dispatch eligibility separated.                                                               | Through `a755bae`      |
| Dispatch evidence and logs               | Outbox intent owns immutable send evidence; runtime stage logs only observe. Provider adapter, polling sender and durable wake-ups remain.                                                | `5769b5b`; ADR 0016    |
| AI extraction flow                       | Admission → context → AI analysis → reply planning → commit → notifications. Separate results writer, state applier and capacity recovery. Effect utilities with Nest DI; no new retries. | Working tree; ADR 0017 |
| Deferred test cleanup                    | Two large suites and three harnesses moved to `vibes/`; assertions and normal test discovery preserved. Structural cleanup is deferred.                                                   | Working tree           |
| Types near their owners                  | Five neighboring `*.types.ts` modules; direct type imports and shorter method signatures. Required/optional/nullable fields preserved.                                                    | Working tree           |

## Remaining, in order

| Order | Scope                             | Completion criterion                                                                                                                                                                                    |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next  | Materialization                   | The entry flow clearly routes incoming testimony, STOP, observed outbound messages and post-closure messages. Cohesive handlers expose purpose; transaction and lock ordering remain explicit.          |
| 2     | Staff actions                     | Reading the inbox, takeover/resume/close, staff messages and result corrections have clear owners and understandable entry operations.                                                                  |
| 3     | Campaign summary                  | Claim/recovery, context assembly, generation, persistence and notification have visible boundaries.                                                                                                     |
| 4     | Delivery and repository review    | Walk the dispatcher and large repositories; split mixed responsibilities where useful while preserving polling, FIFO, fencing and ambiguous-send rules. Large-file exceptions must have a clear reason. |
| 5     | Final production review           | Independently walk ordinary, STOP, handoff, superseded and failed turns across the full mechanism. Resolve remaining readability problems, not just file-size warnings.                                 |
| 6     | Deferred tests and harnesses      | Review the `vibes/` suites against documented behavior, separate fixtures/cases, remove duplication and return reviewed tests beside their owners. Keep them running throughout earlier work.           |
| 7     | Reading and interview preparation | Read the mechanism with the user, explain each boundary and failure case, and distinguish the original chat functionality from the campaign extension.                                                  |

## Current reading map

Line counts describe the 2026-09-06 working tree; they are not acceptance gates.

| Entry or mechanism                                                                                                              | Lines | Status                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ----: | ----------------------------------------------------- |
| [Extractor](../../../apps/backend/src/modules/post-event-feedback/extraction/extract.service.ts)                                |   179 | Split; entry recipe                                   |
| [AI turn coordinator](../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-turn.service.ts)              |    66 | Split; three planning stages                          |
| [Extraction commit](../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-commit.service.ts)              |   505 | Transaction coordinator with separate writers         |
| [Materializer](../../../apps/backend/src/modules/post-event-feedback/ingress/materialize.service.ts)                            | 1,112 | Next responsibility split                             |
| [Staff actions](../../../apps/backend/src/modules/post-event-feedback/inbox/conversation.service.ts)                            | 1,317 | Pending                                               |
| [Summary](../../../apps/backend/src/modules/post-event-feedback/summary/summary.service.ts)                                     | 1,076 | Pending                                               |
| [Dispatcher](../../../apps/backend/src/modules/post-event-feedback/outbox/dispatcher.service.ts)                                |   879 | Further review pending                                |
| [Outbox repository](../../../apps/backend/src/modules/post-event-feedback/outbox/outbox.repository.ts)                          | 1,453 | Types separated; responsibility review pending        |
| [Conversation repository](../../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.repository.ts) | 1,387 | Storage/state/types separated; further review pending |

The 4,543-line `vibes/extraction/extract.service.spec.ts` is a deferred test
suite with embedded fixtures and fakes. It is not the extractor implementation.
Smaller coordinator files reflect moved responsibilities, not equivalent net
deletion of code.

## Verification and working rules

Latest full `pnpm check`: passed after the type-organization pass. Backend:
1,496 passed / 43 opt-in skipped; admin: 389 passed; database: 31 passed;
scripts: 138 passed / 1 skipped. Format, docs, API drift, typecheck, lint and
build passed. The separate disposable PostgreSQL runner passed 78 checks at
`5769b5b`; it was not rerun for the later structural moves. No live migration
or deployment was performed by these refactor passes.

Astra independently reviewed the extraction split. Root reviewed and
integrated the Grok implementations. The type pass also verified equivalent
emitted JavaScript syntax trees and all 35 moved contracts.

For each next batch, name one bounded flow, its intended caller and the
completion criterion before assigning work. Prefer Cursor Grok 4.6 xhigh fast
for bulk implementation; root reads critical code, integrates and validates.
Use independent review for substantive flow changes. At the checkpoint,
update this page with completed scope, remaining work, verification and Git
state before selecting another batch.

Follow the [readability guide](post-event-feedback-readability.md),
[module contract](post-event-feedback.md) and
[scenarios](post-event-feedback-scenarios.md). Preserve storage, STOP/profanity,
consent, model and retry policy during structural work. Use coherent names and
short purpose comments; keep transactions explicit. Effect remains utility
composition without Tags, Context or Layers. A hypothetical example is not a
new permanent workstream.
