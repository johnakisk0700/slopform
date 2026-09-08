# Backend module inventory

Product modules that own durable invariants, permissions or lifecycle.
Cross-cutting infrastructure: [mechanisms](../mechanisms/README.md). Writing
conventions: [documentation standard](../../documentation-standard.md).

| Page                                                                           | Owns                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [overview.md](overview.md)                                                     | Admin Operations snapshot aggregates (events, participants, feedback, outbox, summaries)                 |
| [conversations.md](conversations.md)                                           | MongoDB schema-v1 Assistant aggregate in `conversation_threads`                                          |
| [post-event-feedback.md](post-event-feedback.md)                               | Full feedback loop (questions, PostgreSQL conversations, webhook, extraction, delivery, inbox, takeover) |
| [campaign-topic-analysis.md](campaign-topic-analysis.md)                       | Immutable extracted-note snapshots, cached embeddings, bounded Python clustering and persisted topics    |
| [post-event-feedback-policy-answers.md](post-event-feedback-policy-answers.md) | Approved participant-facing policy sentences (synced with `policy-answers.ts`)                           |
| [post-event-feedback-scenarios.md](post-event-feedback-scenarios.md)           | Executable behavior suite, end states, known defects, harness/corpus contracts                           |
| [events.md](events.md)                                                         | Stub events, attendance corrections, shared D16 feedback-candidate helper                                |
| [assistant.md](assistant.md)                                                   | Authenticated owner-scoped AI threads and durable generation turns                                       |
| [email-delivery.md](email-delivery.md)                                         | Email intent, outbox, optional Resend delivery, redacted attempts and admin visibility                   |
| [participants.md](participants.md)                                             | Canonical profiles, feedback WhatsApp opt-in, WordPress import                                           |

Health routes own liveness/readiness; see [runtime operations](../mechanisms/runtime-operations.md).
