# Backend mechanisms

Read the relevant mechanism page before changing cross-cutting infrastructure.
Update it with the implementation.

| Mechanism                       | Contract                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| [Queues and workers](queues.md) | BullMQ production, consumption, retries, idempotency and observability |

Add a focused page when a mechanism gains its own lifecycle or operational
failure modes—for example authentication/session handling, payment callbacks,
transactional outbox delivery or provider notifications. Domain CRUD does not
need a mechanism page merely because it contains functions.
