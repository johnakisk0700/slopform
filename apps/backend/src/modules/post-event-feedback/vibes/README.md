# Feedback tests awaiting structural review

`vibes/` marks deferred cleanup of the large extraction and staff-action suites
and their shared test harnesses. Review their structure after the feedback
mechanisms settle. The move preserves their assertions and execution.

| File                                        | Current responsibility                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| `extraction/extract.service.spec.ts`        | Extraction orchestration, recovery and embedded fixtures |
| `inbox/conversation.service.spec.ts`        | Staff actions and embedded persistence fakes             |
| `post-event-feedback-doubles.harness.ts`    | Shared in-memory repositories, transport and fixtures    |
| `post-event-feedback-loop.harness.ts`       | Scenario runner and service composition                  |
| `post-event-feedback-loop-model.harness.ts` | Scripted AI responses and in-flight barriers             |

Vitest still discovers the suites through `src/**/*.spec.ts`; TypeScript still
checks every harness. `pnpm check` includes them. The existing build exclusions
keep `*.spec.ts` and `*.harness.ts` out of the production build.

This folder records readability debt, not a judgment that every assertion is
wrong. Keep the tests running during the mechanism refactor and investigate
failures. Add new focused tests beside their owning production mechanism.

Later, review behavior against the documented scenarios, separate cohesive
cases and fixtures, remove duplication, and move reviewed tests back beside
their owners. Shared doubles must continue using production state transitions;
PostgreSQL locking, capacity and rollback require the real adapter tests.

The loop scenario suites still import these harnesses from outside this folder.
Simulator runtime data (`burst-personas` and the real-model corpus) stays with
the simulator mechanisms.

See the [readability guide](../../../../../../docs/backend/modules/post-event-feedback-readability.md#deferred-test-cleanup)
and [scenario contract](../../../../../../docs/backend/modules/post-event-feedback-scenarios.md).
