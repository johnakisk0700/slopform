# Backend module inventory

Product modules that own durable invariants, permissions or lifecycle.
Cross-cutting infrastructure: [mechanisms](../mechanisms/README.md). Writing
conventions: [documentation standard](../../documentation-standard.md).

| Page                                                                                 | Owns                                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [overview.md](overview.md)                                                           | Admin Operations snapshot aggregates (events, participants, feedback, outbox, summaries)                 |
| [conversations.md](conversations.md)                                                 | MongoDB schema-v1 Assistant aggregate in `conversation_threads`                                          |
| [post-event-feedback.md](post-event-feedback.md)                                     | Full feedback loop (questions, PostgreSQL conversations, webhook, extraction, delivery, inbox, takeover) |
| [post-event-feedback-policy-answers.md](post-event-feedback-policy-answers.md)       | Approved participant-facing policy sentences (synced with `policy-answers.ts`)                           |
| [post-event-feedback-rehearsal-history.md](post-event-feedback-rehearsal-history.md) | Paid rehearsal runs and what those numbers can/cannot argue                                              |
| [post-event-feedback-scenarios.md](post-event-feedback-scenarios.md)                 | Executable behavior suite, end states, known defects, harness/corpus contracts                           |
| [events.md](events.md)                                                               | Stub events, attendance corrections, shared D16 feedback-candidate helper                                |
| [assistant.md](assistant.md)                                                         | Authenticated owner-scoped AI threads and durable generation turns                                       |
| [email-delivery.md](email-delivery.md)                                               | Provider-agnostic email intent, outbox, redacted attempts, admin visibility                              |
| [participants.md](participants.md)                                                   | Canonical profiles, feedback WhatsApp opt-in, WordPress import                                           |

Current feedback refactor progress and next work live in the
[refactor status](post-event-feedback-refactor-status.md).
The [HTML reading guide](post-event-feedback-reading.html) starts the core
message walkthrough before the later staff-action, summary and SQL chapters.
The [2026-07-29 evidence note](../../evidence/post-event-feedback-open-issues-2026-07-29.md)
is a dated audit, not the current work queue.

Not indexed here:

- `src/modules/reference/` — disposable Core/HTTP/Worker pattern, not production
  CRUD. HTTP only with `REFERENCE_MODULE_ENABLED=true`; worker stays to drain
  prior jobs. Remove via forward migration when finished.
- `src/modules/health/` — liveness/readiness only; see
  [runtime-operations](../mechanisms/runtime-operations.md).
