# Backend mechanisms

Read the relevant page before changing cross-cutting infrastructure; update it
with the implementation. Product domains:
[modules](../modules/README.md).

| Mechanism                                            | Contract                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [Admin authentication](authentication.md)            | Clerk sessions, admin authorization, Google-access handoff                  |
| [API contract and generated client](api-contract.md) | OpenAPI emission, admin client generation, drift detection                  |
| [Assistant streaming](assistant-streaming.md)        | Partial text/reasoning over poll; Redis-backed SSE accelerator (stages A+B) |
| [Database lifecycle and migrations](database.md)     | Pool lifecycle, schema ownership, migrations, test data                     |
| [Local data query](local-data-query.md)              | Guarded read-only PostgreSQL, MongoDB and Redis inspection                  |
| [MongoDB lifecycle](mongodb.md)                      | Conversation-store connection, security, indexes, limits, backup            |
| [Queues and workers](queues.md)                      | BullMQ production, consumption, retries, idempotency, observability         |
| [Runtime operations](runtime-operations.md)          | Configuration, HTTP edge, logging, tracing, process failure                 |
| [Wasender integration](wasender.md)                  | WhatsApp transport, webhook verification, normalized events                 |

Add a page when a mechanism gains its own lifecycle or operational failure
modes. Domain CRUD alone does not need one.
