# Backend module inventory

Document product modules here when they own durable invariants, permissions or
lifecycle. Use the [documentation standard](../../documentation-standard.md)
and link the source module. Cross-cutting infrastructure belongs in
[mechanisms](../mechanisms/README.md).

Product modules:

- [`conversations.md`](conversations.md) — MongoDB-authoritative schema-v1
  assistant conversation aggregate; co-tenancy with schema-v2 feedback
  documents in the shared `conversation_threads` collection.
- [`post-event-feedback.md`](post-event-feedback.md) — WP0–WP4 landed
  (question contract, stub events upstream, PostgreSQL persistence, Mongo
  conversation schema v2 owned here, durable webhook ingress and
  materialization); extraction, sending, campaign launch and UI still pending.
- [`post-event-feedback-scenarios.md`](post-event-feedback-scenarios.md) — the
  executable behavior suite, its desired end states and known defects, plus the
  mocked harness and occasional real-model corpus contracts.
- [`events.md`](events.md) — stub events, attendance corrections and the shared
  D16 feedback-candidate helper.
- [`assistant.md`](assistant.md) — authenticated, owner-scoped asynchronous AI
  conversation threads and durable generation turns.
- [`email-delivery.md`](email-delivery.md) — provider-agnostic email intent,
  transactional outbox, redacted attempts and safe admin visibility.
- [`participants.md`](participants.md) — canonical participant profile schema,
  feedback WhatsApp opt-in and controlled WordPress profile import.

`apps/backend/src/modules/reference/` remains a disposable executable pattern,
not production CRUD. Remove the reference route, queue, processor and table
through a reviewed forward migration when the foundation no longer needs the
golden example.

`REFERENCE_MODULE_ENABLED=true` adds only the reference HTTP adapter. Its worker
remains active to drain jobs accepted by an earlier release; disabling producers
must not strand a backlog.

The reference Core/HTTP/Worker split exists because one use-case service is
shared by two executable graphs. It is not a starter kit. A domain used in one
process normally has one Nest module; split adapters only to keep HTTP providers
out of workers or worker providers out of HTTP.
