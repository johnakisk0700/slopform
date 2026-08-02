# Backend mechanisms

Read the relevant mechanism page before changing cross-cutting infrastructure.
Update it with the implementation.

| Mechanism                                            | Contract                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Admin authentication](authentication.md)            | Clerk sessions, admin authorization, Google-access handoff                    |
| [API contract and generated client](api-contract.md) | OpenAPI emission, admin client generation, drift detection                    |
| [Assistant streaming](assistant-streaming.md)        | Partial text and reasoning over the poll, and the SSE stage that is not built |
| [Database lifecycle and migrations](database.md)     | Pool lifecycle, schema ownership, migrations and test data                    |
| [Local data query](local-data-query.md)              | Guarded read-only PostgreSQL, MongoDB and Redis inspection by hand            |
| [MongoDB lifecycle](mongodb.md)                      | Conversation-store connection, security, indexes, limits and backup           |
| [Queues and workers](queues.md)                      | BullMQ production, consumption, retries, idempotency and observability        |
| [Runtime operations](runtime-operations.md)          | Configuration, HTTP edge, logging, tracing and process failure                |
| [Wasender integration](wasender.md)                  | WhatsApp transport, webhook verification and normalized events                |

Add a focused page when a mechanism gains its own lifecycle or operational
failure modes—for example authentication/session handling, payment callbacks,
transactional outbox delivery or provider notifications. Domain CRUD does not
need a mechanism page merely because it contains functions.
