# Backend foundation

Last verified: **2026-07-22**.

The backend is a NestJS modular monolith on Node.js 24 LTS. HTTP and background jobs are two independently deployable processes built from the same codebase and domain modules. PostgreSQL is the system of record; Redis/BullMQ is delivery infrastructure, never the system of record.

## Selected versions and compatibility

Versions are intentionally exact in package manifests. Renovate/Dependabot upgrades should be reviewed as a single compatibility change rather than letting foundational packages drift independently.

| Component                            |                         Version | Reason                                                                                                                                    |
| ------------------------------------ | ------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                              |                   `>=24.11 <25` | Node 24 LTS production line; Nest 11 requires Node 20 or newer.                                                                           |
| NestJS core/default Express platform |                       `11.1.28` | Current stable Nest major; Express remains Nest's default platform.                                                                       |
| Nest OpenAPI                         |                        `11.4.6` | Peer range requires Nest 11.                                                                                                              |
| `@nestjs/bullmq` / BullMQ            |            `11.0.4` / `5.80.10` | Nest 10/11 and BullMQ 3–5 peer ranges overlap. Legacy Bull is not used.                                                                   |
| Bull Board                           |                         `8.1.2` | Its Nest package supports Nest 9–11 and BullMQ adapters.                                                                                  |
| Drizzle ORM / Kit / `pg`             | `0.45.2` / `0.31.10` / `8.22.0` | Drizzle's `node-postgres` path supports `pg >=8`.                                                                                         |
| Zod / `nestjs-zod`                   |               `4.4.3` / `5.4.0` | `nestjs-zod` supports Nest 10/11, Swagger 11, and Zod 3.25/4.                                                                             |
| Pino / `nestjs-pino`                 |              `10.3.1` / `4.6.1` | `nestjs-pino` supports Nest 8–11 and Pino 7–10.                                                                                           |
| TypeScript                           |                         `5.9.3` | Deliberately conservative stable compiler for Nest decorators; TypeScript 7 was not adopted merely because the registry called it latest. |

The selected core libraries are permissive open-source dependencies. BullMQ OSS is used; BullMQ Pro is not. Recheck licenses as part of dependency-upgrade review rather than treating this paragraph as eternal legal scripture.

## Process topology

```text
HTTP process (main-http.ts)
  controllers -> application services -> repositories -> Drizzle -> PostgreSQL
                    |
                    +-> BullMQ producers -> Redis

Worker process (main-worker.ts)
  BullMQ processors -> the same application services/repositories -> PostgreSQL
```

`pnpm --filter @join-the-six/backend dev` runs both watch processes. `dev:http` and `dev:worker` are available when debugging one process. Production starts them separately with `start:http` and `start:worker`, so they can be scaled and restarted independently.

The HTTP process owns controllers, CORS, OpenAPI, liveness/readiness, producers and the optional Bull Board. The worker is a Nest standalone application context: it has dependency injection and lifecycle hooks, but no accidental HTTP listener.

## Source layout

```text
apps/backend/src/
  infrastructure/
    audit/            append-only business audit writes
    config/           one validated environment contract
    database/         pool lifecycle and transaction boundary
    logging/          structured runtime logging and redaction
    observability/    OpenTelemetry/Sentry lifecycle seams
    queue/            BullMQ connection, defaults, health and dashboard
  modules/
    health/           liveness and dependency readiness
    reference/        disposable golden module
  http-app.module.ts
  worker-app.module.ts
  main-http.ts
  main-worker.ts

packages/database/
  src/schema/         Drizzle schema source of truth
  drizzle/            versioned, reviewable SQL migrations
```

The `reference` module is an executable pattern, not a product domain. It is disabled unless `REFERENCE_MODULE_ENABLED=true`. Copy its boundaries for the first real module, then remove `reference_records`, the reference queue/processor/routes, and add a forward migration. Do not grow it into a generic CRUD framework.

## Adding a domain module

A small model should be able to extend the backend without inventing architecture:

1. Put request, parameter, response and job payload Zod schemas in `<domain>.schemas.ts`.
2. Derive Nest DTO classes with `createZodDto`. The same schema drives runtime validation, TypeScript and OpenAPI. Do not add a parallel `class-validator` DTO.
3. Keep controllers limited to HTTP concerns: DTOs, guards, actor/request context, status codes and delegation.
4. Put use-case ordering, invariants and transaction scope in the service.
5. Put explicit Drizzle queries in a domain-named repository. Repositories do not decide business workflows or open hidden transactions.
6. Export the smallest useful provider surface from a core module. Add separate HTTP and worker modules only when the domain needs those adapters.
7. Add the controller module only to `HttpAppModule`; add processors only to `WorkerAppModule`.

Do not create an interface for every class. Introduce a port only when there are genuinely multiple adapters or when the boundary is external and useful in tests. TypeScript already has structural typing; it does not need ceremonial paperwork.

## Database, transactions and audit

The Drizzle TypeScript schema in `packages/database/src/schema` is the schema source of truth. Production changes use versioned SQL:

```bash
pnpm --filter @join-the-six/database db:generate
# Read the generated SQL. Check locks, backfills, defaults and destructive statements.
pnpm --filter @join-the-six/database db:check
pnpm --filter @join-the-six/database db:migrate
```

Never run `drizzle-kit push` in staging or production. It bypasses the reviewable migration history. For risky changes, use expand/backfill/contract migrations across separate releases.

The service owns transaction scope. When a business mutation requires an audit event, write the domain row and `audit_events` row in the **same PostgreSQL transaction**, as `ReferenceService.create` demonstrates. Runtime logs and business audit are different:

- Pino/Sentry/OTel answer “what failed, where, and how slowly?” They can expire.
- `audit_events` answers “who changed which business entity, when, and under which request?” It is durable application data.

Audit context must be deliberately small. Do not dump request bodies, credentials, questionnaire answers, payment payloads or other personal data into JSON because it was convenient at 17:55 on Friday.

## Queues, retries and idempotency

The focused, agent-readable mechanism contract and flow diagram live in
[`backend/mechanisms/queues.md`](backend/mechanisms/queues.md). Update that page
with any queue topology, payload, retry, idempotency or operational change.

Use BullMQ, not legacy Bull. Each job name and payload has a versionable contract. Validate job data again in the processor: Redis may contain jobs written by an older deployment or another producer.

Rules:

- Producers supply a deterministic `jobId` from a domain idempotency key. BullMQ job IDs must not contain `:`.
- A stable job ID suppresses duplicate queue entries while that job remains in Redis; it does **not** make side effects exactly-once.
- A processor that writes externally must also use a durable idempotency key or database uniqueness constraint at the side-effect boundary.
- Throw on transient failure and let the configured attempts/exponential backoff work. Do not catch-and-log success.
- Keep payloads small and identifier-based. Fetch current authoritative state inside the processor.
- Treat jobs as potentially duplicated, delayed and out of order.
- For a business-critical “DB commit must eventually enqueue” workflow, write a transactional outbox row in the same PostgreSQL transaction and relay it. A plain `commit(); queue.add()` has a crash gap.
- Correlation/request IDs travel in job data and logs. Never place secrets in job data; Bull Board and Redis operators can inspect it.

Default retention is bounded (`removeOnComplete` and `removeOnFail`) so Redis does not become a landfill with a dashboard attached. Bull Board is read-only, disabled by default, and requires credentials when enabled. Put it behind private networking/SSO in production even with Basic authentication.

## Health and observability

- `GET /api/v1/health/live` proves that the HTTP process is alive; it does not touch dependencies.
- `GET /api/v1/health/ready` checks PostgreSQL and a real BullMQ Redis operation. Remove an instance from traffic when this fails.
- `GET /api/docs` serves Swagger UI; `/api/openapi.json` and `/api/openapi.yaml` expose the contract.
- Bull Board is mounted under `/api/v1/admin/queues` by Nest's global prefix when enabled.

Pino emits JSON, propagates/creates `x-request-id`, redacts authorization/cookie/common secret fields, and attaches active OpenTelemetry trace/span IDs. Add redaction paths when a new endpoint introduces a sensitive field; logging it first and apologizing later is not observability.

Instrumentation is preloaded before Nest. Configure exactly one tracing path per process:

- `OTEL_EXPORTER_OTLP_ENDPOINT` for vendor-neutral OTLP, or
- `SENTRY_DSN` for the official NestJS Sentry SDK.

Environment validation rejects both at once to prevent duplicate auto-instrumentation. `OnApplicationShutdown` closes DB pools and telemetry exporters; Nest shutdown hooks handle `SIGTERM`/`SIGINT`.

## Environment

`apps/backend/.env.example` lists every backend-specific variable. Direct commands run from `apps/backend` read that file when copied to `.env`; root `pnpm dev` injects the repository-root environment.

Required:

- `DATABASE_URL`

Defaults exist for `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `DATABASE_POOL_MAX`, `REDIS_URL`, `LOG_LEVEL`, `OTEL_SERVICE_NAME` and `SENTRY_TRACES_SAMPLE_RATE`. Optional/guarded variables are `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN`, `BULL_BOARD_*` and `REFERENCE_MODULE_ENABLED`.

Never commit production credentials. Use the deployment platform's secret manager.

## Commands and verification

From the repository root:

```bash
pnpm infra:up
pnpm --filter @join-the-six/database build
pnpm --filter @join-the-six/database db:migrate
pnpm --filter @join-the-six/backend dev

pnpm --filter @join-the-six/backend typecheck
pnpm --filter @join-the-six/backend test
pnpm --filter @join-the-six/backend build
pnpm --filter @join-the-six/database db:check
```

Unit tests should cover pure schemas, invariants and service orchestration without booting Nest. Repository integration tests should run against real PostgreSQL and verify constraints/rollback. Queue integration tests should use real Redis, deterministic job IDs, bounded waits and unique queue prefixes. HTTP contract tests should boot `createHttpApplication()` and assert both response bodies and generated OpenAPI. Mocking Drizzle's fluent chain or BullMQ internals usually produces tests of the mock author's imagination.

## Explicit anti-patterns

- No microservices, CQRS, event sourcing or distributed transactions for this MVP.
- No generic repository/base-service framework.
- No interface/implementation pair per class.
- No controller-level Drizzle queries or business decisions.
- No untyped `Record<string, any>` request/job payloads.
- No duplicated Zod/class-validator/OpenAPI schemas.
- No `drizzle-kit push` outside disposable local databases.
- No queue job treated as exactly-once.
- No business audit encoded only in runtime logs.
- No public Bull Board.
- No cross-domain `utils/` drawer full of unrelated knives.

## Official documentation used

- Node.js release lines: <https://nodejs.org/en/about/previous-releases>
- Nest first steps and Node requirement: <https://docs.nestjs.com/first-steps>
- Nest modules/providers: <https://docs.nestjs.com/modules>, <https://docs.nestjs.com/providers>
- Nest standalone worker contexts: <https://docs.nestjs.com/standalone-applications>
- Nest lifecycle/shutdown hooks: <https://docs.nestjs.com/fundamentals/lifecycle-events>
- Nest BullMQ queues: <https://docs.nestjs.com/techniques/queues>
- Nest OpenAPI: <https://docs.nestjs.com/openapi/introduction>
- Drizzle PostgreSQL: <https://orm.drizzle.team/docs/get-started/postgresql-existing>
- Drizzle Kit/migrations: <https://orm.drizzle.team/docs/kit-overview>
- Drizzle `generate` versus `push`: <https://orm.drizzle.team/docs/faq#should-i-use-generate-or-push>
- BullMQ idempotent jobs: <https://docs.bullmq.io/patterns/idempotent-jobs>
- BullMQ job IDs: <https://docs.bullmq.io/guide/jobs/job-ids>
- BullMQ retrying failures: <https://docs.bullmq.io/guide/retrying-failing-jobs>
- Bull Board and Nest adapter: <https://github.com/felixmosh/bull-board/tree/master/packages/nestjs>
- `nestjs-zod`: <https://github.com/BenLorantfy/nestjs-zod>
- Zod: <https://zod.dev/>
- `nestjs-pino`: <https://github.com/iamolegga/nestjs-pino>
- Pino redaction: <https://getpino.io/#/docs/redaction>
- OpenTelemetry Node.js: <https://opentelemetry.io/docs/languages/js/getting-started/nodejs/>
- Sentry NestJS SDK: <https://docs.sentry.io/platforms/javascript/guides/nestjs/>
