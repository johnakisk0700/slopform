# Queues and workers

Status: implemented foundation. Last verified: **2026-07-22** against
`@nestjs/bullmq 11.0.4`, `bullmq 5.80.10` and Bull Board `8.1.2`.

## Purpose and boundary

BullMQ handles retryable asynchronous delivery. Redis coordinates jobs but is
not a business source of truth. Nest runs queue producers in the HTTP process
and processors in a separately deployable worker process.

The current `reference` queue is a disposable executable example, not a product
domain. A transactional outbox is required before claiming atomic
database-to-queue delivery for critical workflows; it is not implemented yet.

## Dialogue

```mermaid
sequenceDiagram
  participant API as Nest API
  participant DB as PostgreSQL
  participant Queue as BullMQ / Redis
  participant Worker as Nest worker
  participant Provider as External provider

  API->>DB: Validate authoritative state
  API->>Queue: Add versioned job with deterministic ID
  Queue-->>Worker: Deliver job (possibly more than once)
  Worker->>Worker: Validate payload contract
  Worker->>DB: Reload current authoritative state
  Worker->>Provider: Perform idempotent side effect
  alt transient failure
    Worker-->>Queue: Throw; retry with backoff
  else success
    Worker-->>Queue: Complete with bounded retention
  end
```

## Invariants

- Job names and payloads are versionable contracts and are validated again by
  the processor.
- Producers use deterministic `jobId` values without `:` characters.
- Delivery may be duplicated, delayed or out of order. Stable BullMQ IDs only
  suppress duplicates while the original job remains in Redis.
- External writes require a durable provider idempotency key or database
  uniqueness boundary.
- Payloads contain identifiers and correlation metadata, never credentials or
  large authoritative snapshots.
- Transient failures are thrown so attempts/backoff remain observable.
- Completed and failed jobs have bounded retention.

## Extension path

1. Define the queue/job names and a strict payload schema near the owning domain.
2. Register producers only in the HTTP/domain adapter and processors only in the
   worker module.
3. Fetch current state in the processor and make every effect idempotent.
4. Add focused schema/service tests plus a real Redis integration test for job
   IDs, retries and processing.
5. Add an outbox row in the same PostgreSQL transaction before using a queue for
   a business-critical commit-and-enqueue guarantee.
6. Update this page and the owning domain document when the contract changes.

## Operations

- Readiness performs a real BullMQ Redis operation at
  `GET /api/v1/health/ready`.
- Bull Board is disabled by default. When enabled it requires credentials and
  must remain behind private networking or SSO.
- Correlation IDs travel in job data and structured logs.
- Scale API and worker containers independently; workers do not expose HTTP.

## Source and references

- Queue infrastructure: `apps/backend/src/infrastructure/queue/`
- Reference producer/processor: `apps/backend/src/modules/reference/`
- Process composition: `apps/backend/src/http-app.module.ts` and
  `apps/backend/src/worker-app.module.ts`
- [Backend handbook](../../backend.md)
- [Nest BullMQ queues](https://docs.nestjs.com/techniques/queues)
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)
- [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
