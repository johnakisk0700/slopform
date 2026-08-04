# Backend module inventory

Document product modules here when they own durable invariants, permissions or
lifecycle. Use the [documentation standard](../../documentation-standard.md)
and link the source module. Cross-cutting infrastructure belongs in
[mechanisms](../mechanisms/README.md).

Product modules:

- [`overview.md`](overview.md) — authenticated admin Operations snapshot:
  exact PostgreSQL and MongoDB aggregates for events, participants, feedback
  conversations, outbox and summaries.
- [`conversations.md`](conversations.md) — MongoDB-authoritative schema-v1
  assistant conversation aggregate; co-tenancy with schema-v2 feedback
  documents in the shared `conversation_threads` collection.
- [`post-event-feedback.md`](post-event-feedback.md) — the whole loop, and the
  largest module in the repo: question contract, PostgreSQL persistence, Mongo
  conversation schema v2, webhook ingress and materialization, model extraction,
  outbound delivery, campaign launch, the admin inbox and human takeover. WP0–WP8
  are implemented; what is still open is recorded in
  [the 2026-07-29 evidence note](../../evidence/post-event-feedback-open-issues-2026-07-29.md),
  not here.
- [`post-event-feedback-policy-answers.md`](post-event-feedback-policy-answers.md)
  — **draft, nothing approved**: what the bot may say when somebody asks what
  happens to their answers. Governs a data-handling commitment, so it is indexed
  here rather than left two levels down.
- [`post-event-feedback-rehearsal-history.md`](post-event-feedback-rehearsal-history.md)
  — every paid rehearsal run, and what those numbers can and cannot argue.
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

`src/modules/health/` has no page here on purpose: it owns liveness and
readiness routes and no durable product boundary, so it falls outside this
directory's rule. Its behaviour is documented in
[runtime-operations](../mechanisms/runtime-operations.md).

The reference Core/HTTP/Worker split exists because one use-case service is
shared by two executable graphs. It is not a starter kit. A domain used in one
process normally has one Nest module; split adapters only to keep HTTP providers
out of workers or worker providers out of HTTP.
