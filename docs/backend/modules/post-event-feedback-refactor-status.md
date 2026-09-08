# Feedback refactor status

Last updated: **2026-09-06**. This is the current progress and next-work map.
Update it at each checkpoint; confirm Git status before resuming. Completed
rows are records of finished work, not instructions to repeat it.

The [portfolio plan](../../portfolio-plan.md) adds the 2026-09-07 product/demo
decisions and Notion task board. It does not change the implementation
checkpoint or mark the remaining refactor work complete.

## Where we are

**The core incoming-message → AI → outbound-send path is ready for a first
guided reading. The whole module is not finished.** Start with the
[HTML reading guide](post-event-feedback-reading.html): six actual methods,
355 lines including comments and observations, followed by four scenario walks.
Open the HTML directly in a browser; it needs no server or dependencies.

Checkpoint `7f55117` committed the AI flow, Effect utilities, deferred-test
relocation and neighboring contracts. The subsequent core-message checkpoint
(the commit containing this revision) adds materialization and dispatcher
owners, wiring and this reading guide. No implementation agent is running.
Confirm Git status and remote state before resuming; these entries describe
code checkpoints, not deployment or migration completion.

## Completed

| Work                                     | Result                                                                                                                                                                                    | Checkpoint          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Conversation storage                     | Campaign feedback conversations use PostgreSQL; Assistant threads retain MongoDB. Feedback no longer needs the former cross-database conversation sync.                                   | `3af4d43`; ADR 0015 |
| Persistence and orchestration boundaries | Explicit repositories and service-owned transactions; execution fencing, turn decisions and dispatch eligibility separated.                                                               | Through `a755bae`   |
| Dispatch evidence and logs               | Outbox intent owns immutable send evidence; runtime stage logs only observe. Provider adapter, polling sender and durable wake-ups remain.                                                | `5769b5b`; ADR 0016 |
| AI extraction flow                       | Admission → context → AI analysis → reply planning → commit → notifications. Separate results writer, state applier and capacity recovery. Effect utilities with Nest DI; no new retries. | `7f55117`; ADR 0017 |
| Deferred test cleanup                    | Two large suites and three harnesses moved to `vibes/`; assertions and normal test discovery preserved. Structural cleanup is deferred.                                                   | `7f55117`           |
| Types near their owners                  | Five neighboring `*.types.ts` modules; direct type imports and shorter method signatures. Required/optional/nullable fields preserved.                                                    | `7f55117`           |
| Materialization                          | Route selection, pending-ingress replay protocol, inbound/media/capacity, deterministic STOP, closed inbound and observed outbound have named owners.                                     | This checkpoint     |
| Basic dispatcher flow                    | Batch claim, recovery, one-message attempt, locked preparation and provider-result settlement have named owners. Polling, pacing, FIFO and uncertainty policy preserved.                  | This checkpoint     |
| Reading guide                            | Standalone Greek HTML/CSS, six source-method excerpts, four scenario walks, local reading progress and print layout.                                                                      | This checkpoint     |

## Remaining, in order

| Order | Scope                                    | Completion criterion                                                                                                                                                                          |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next  | Read the core message path               | Walk the HTML guide with the user: normal reply, STOP, newer testimony during AI and uncertain delivery. Explain purpose and extension boundaries before selecting another refactor batch.    |
| 2     | Staff actions                            | Reading the inbox, takeover/resume/close, staff messages and result corrections have clear owners and understandable entry operations.                                                        |
| 3     | Campaign summary                         | Claim/recovery, context assembly, generation, persistence and notification have visible boundaries.                                                                                           |
| 4     | Repository and remaining delivery detail | Review the large SQL owners and any legacy delivery bridge; the ordinary dispatcher has already been split and reviewed. Large-file exceptions must have a clear reason.                      |
| 5     | Final production review                  | Independently walk ordinary, STOP, handoff, superseded and failed turns across the full mechanism. Resolve remaining readability problems, not just file-size warnings.                       |
| 6     | Deferred tests and harnesses             | Review the `vibes/` suites against documented behavior, separate fixtures/cases, remove duplication and return reviewed tests beside their owners. Keep them running throughout earlier work. |
| 7     | Deeper interview preparation             | Extend the initial walkthrough to staff actions, summaries, SQL guarantees and the remaining failure cases. Initial reading is not blocked on these later chapters or test cleanup.           |

## Current reading map

Line counts describe the 2026-09-06 core-message checkpoint; they are not acceptance gates.

| Entry or mechanism                                                                                                              | Lines | Status                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ----: | ----------------------------------------------------- |
| [Extractor](../../../apps/backend/src/modules/post-event-feedback/extraction/extract.service.ts)                                |   179 | Split; entry recipe                                   |
| [AI turn coordinator](../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-turn.service.ts)              |    66 | Split; three planning stages                          |
| [Extraction commit](../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-commit.service.ts)              |   505 | Transaction coordinator with separate writers         |
| [Materializer](../../../apps/backend/src/modules/post-event-feedback/ingress/materialize.service.ts)                            |   174 | Routing entry; handlers 130–376 lines                 |
| [Staff actions](../../../apps/backend/src/modules/post-event-feedback/inbox/conversation.service.ts)                            | 1,317 | Pending                                               |
| [Summary](../../../apps/backend/src/modules/post-event-feedback/summary/summary.service.ts)                                     | 1,076 | Pending                                               |
| [Dispatcher](../../../apps/backend/src/modules/post-event-feedback/outbox/dispatcher.service.ts)                                |   102 | Batch recipe                                          |
| [Single-message attempt](../../../apps/backend/src/modules/post-event-feedback/outbox/dispatch-attempt.service.ts)              |   257 | Guard → transcript → pacing → prepare → send → settle |
| [Dispatch preparation](../../../apps/backend/src/modules/post-event-feedback/outbox/dispatch-preparation.service.ts)            |   345 | Current-state guards and marker transaction           |
| [Outbox repository](../../../apps/backend/src/modules/post-event-feedback/outbox/outbox.repository.ts)                          | 1,453 | Types separated; responsibility review pending        |
| [Conversation repository](../../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.repository.ts) | 1,387 | Storage/state/types separated; further review pending |

The 4,543-line `vibes/extraction/extract.service.spec.ts` is a deferred test
suite with embedded fixtures and fakes. It is not the extractor implementation.
Smaller coordinator files reflect moved responsibilities, not equivalent net
deletion of code.

## Verification and working rules

Latest full `pnpm check`: passed for the core-message checkpoint. Backend:
1,496 passed / 43 opt-in skipped; admin: 389 passed; database: 31 passed;
scripts: 138 passed / 1 skipped. Format, docs, API drift, typecheck, lint and
build passed. The separate disposable PostgreSQL runner passed 78 checks at
`5769b5b`; it was not rerun for the later structural moves. SQL, schema and
lock order were unchanged by this split. No live migration
or deployment was performed by these refactor passes.

Astra independently reviewed the extraction split and the subsequent complete
materialization/dispatch operations against their checkpoint: no actionable
findings. Root read and integrated the Grok implementations. The type pass also
verified equivalent emitted JavaScript syntax trees and all 35 moved contracts.
The core-message pass ran 229 focused checks before the full gate; the HTML
guide was checked for source-excerpt accuracy, local links, reading progress
and desktop/mobile layout.

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
