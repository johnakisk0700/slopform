# Backend foundation

Last verified: **2026-07-22**.

The backend is a NestJS modular monolith on Node.js 24 LTS. HTTP and background jobs are two independently deployable processes built from the same codebase and domain modules. PostgreSQL is the system of record; Redis/BullMQ is delivery infrastructure, never the system of record.

## Selected versions and compatibility

Versions are intentionally exact in package manifests. Renovate/Dependabot upgrades should be reviewed as a single compatibility change rather than letting foundational packages drift independently.

| Component                                 |                                    Version | Compatibility boundary                                                                                                        |
| ----------------------------------------- | -----------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| Node.js                                   |                              `>=24.11 <25` | Node 24 LTS production line; Nest 11 requires Node 20 or newer.                                                               |
| Nest core / Express platform              |                        `11.1.28` / `5.2.1` | `@nestjs/common`, core and platform stay on one patch. Express is supplied by `@nestjs/platform-express`.                     |
| Nest config / OpenAPI                     |                         `4.0.4` / `11.4.6` | Config supports Nest 10/11; Swagger 11 requires Nest 11.                                                                      |
| Express types                             |                                    `5.0.6` | Matches the Express 5 runtime and is development-only.                                                                        |
| `@nestjs/bullmq` / BullMQ                 |                       `11.0.4` / `5.80.10` | Nest 10/11 and BullMQ 3–5 peer ranges overlap. Legacy Bull is not used.                                                       |
| Bull Board                                |                                    `8.1.2` | Its Nest package supports Nest 9–11 and the BullMQ adapter. All three Bull Board packages stay on one version.                |
| Drizzle ORM / Kit / `pg` / `@types/pg`    | `0.45.2` / `0.31.10` / `8.22.0` / `8.20.0` | Drizzle's `node-postgres` path supports `pg >=8`; the Drizzle 1.0 tags are prereleases, not the stable line.                  |
| Zod / `nestjs-zod`                        |                          `4.4.3` / `5.4.0` | `nestjs-zod` supports Nest 10/11, Swagger 11 and Zod 3.25/4.                                                                  |
| Pino / `pino-http` / `nestjs-pino`        |              `10.3.1` / `11.0.0` / `4.6.1` | `nestjs-pino` supports Nest 8–11, Pino 7–10 and `pino-http` 6–11.                                                             |
| OpenTelemetry API / SDK + exporter / auto | `1.9.1` / `0.220.0` / `0.220.0` / `0.78.0` | The auto-instrumentation metapackage and Sentry use the `0.220` instrumentation cohort; upgrade this set together.            |
| Sentry Nest SDK                           |                                  `10.67.0` | Supports Nest 8–11 and Node 18 or newer. It is an alternative tracing path, not a second tracer provider beside the OTLP SDK. |
| `dotenv` / `reflect-metadata` / RxJS      |               `17.4.2` / `0.2.2` / `7.8.2` | `dotenv` is imported by the preload; metadata and RxJS satisfy Nest's runtime peers.                                          |
| TypeScript / Node types                   |                        `6.0.3` / `24.13.3` | TypeScript 6 preserves Nest's legacy decorator metadata and the Node types remain on the supported runtime major.             |
| Vitest                                    |                                   `4.1.10` | Supports Node 20, 22 and 24+.                                                                                                 |

Registry metadata, installed peer manifests, release notes and licenses were
rechecked on **2026-07-22**. The pins are the latest stable registry versions
except where the supported line is intentionally narrower:

- TypeScript 7.0.2 has no stable programmatic API yet and its own release notes
  call out ecosystem restrictions. The backend and database both pass with the
  repository's TypeScript 6.0.3 compiler, including Nest decorator metadata and
  declaration emit.
- OpenTelemetry SDK/exporter 0.221.0 was released after
  `@opentelemetry/auto-instrumentations-node 0.78.0`, which depends on the 0.220
  SDK/instrumentation cohort. Pinning the direct SDK/exporter to 0.220.0 avoids
  loading two experimental SDK cohorts. Do not force an override across
  OpenTelemetry's `0.x` packages; update after their declared dependency graph
  converges and the trace smoke passes.
- `@types/node` stays on the latest Node 24 line rather than following the
  registry's Node 26 default while production remains on Node 24 LTS.

Direct production packages and their resolved production trees use permissive
MIT, Apache-2.0, BSD, ISC, 0BSD, BlueOak-1.0.0 or Python-2.0 licenses in the
2026-07-22 scan; no production advisory was reported. BullMQ OSS is used,
not BullMQ Pro. Recheck both licenses and advisories during upgrades rather than
treating a point-in-time scan as a legal force field.

Dependency placement is deliberate:

- `pino` and `pino-http`, plus Nest's `reflect-metadata` and RxJS peers, remain
  direct runtime dependencies even though application files mostly import their
  adapters. pnpm should not be asked to smuggle required peers through a
  transitive dependency.
- `drizzle-orm` is direct in both packages: the database package owns the client
  and schema, while backend repositories import query operators such as `eq`.
- `dotenv` is runtime in the backend because the instrumentation preload imports
  it, but development-only in the database package because only Drizzle Kit's
  config imports it.
- `@types/express` is development-only. Express itself is owned by Nest's
  platform package; application imports are type-only.
- `@nestjs/testing`, Supertest and its types are not installed speculatively.
  Add them together when an HTTP integration test actually imports them.

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

Nest's validated `ConfigModule` is intentionally global. `DatabaseService` and
named queue providers stay module-scoped and each consumer imports their owning
module explicitly. Nest modules are shared by default, so explicit imports
document dependency edges without creating extra pools or queues. HTTP-only
Sentry interception and exception filtering are registered only in
`HttpAppModule`; the standalone worker owns telemetry shutdown but no dead HTTP
plumbing.

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

The `reference` module is an executable pattern, not a product domain. Its HTTP
adapter is absent from the Nest graph unless `REFERENCE_MODULE_ENABLED=true`,
so disabled routes are also absent from OpenAPI. The worker remains registered
to drain jobs accepted by an earlier deployment; disabling producers must not
silently strand a backlog. Copy its boundaries for the first real module, then
remove `reference_records`, the reference queue/processor/routes, and add a
forward migration. Do not grow it into a generic CRUD framework.

## Adding a domain module

A small model should be able to extend the backend without inventing architecture:

1. Put request, parameter, response and job payload Zod schemas in `<domain>.schemas.ts`.
2. Derive Nest DTO classes with `createZodDto`. The same schema drives runtime validation, TypeScript and OpenAPI. Do not add a parallel `class-validator` DTO.
3. Keep controllers limited to HTTP concerns: DTOs, actor/request context,
   status codes, transport-error mapping and delegation. Application services
   consume schema-inferred plain types rather than HTTP DTO classes.
4. Put use-case ordering, transport-neutral errors, invariants and transaction
   scope in the service.
5. Put explicit Drizzle queries in a domain-named repository. Repositories do not decide business workflows or open hidden transactions.
6. Export the smallest useful provider surface from a core module. Import
   database/queue modules at the feature module that consumes them; do not rely
   on ambient global providers. Add separate HTTP and worker modules only when
   the domain needs those adapters.
7. Add the controller module only to `HttpAppModule`; add processors only to
   `WorkerAppModule`.

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
- Throw BullMQ `UnrecoverableError` for an invalid payload, unsupported job name
  or another permanent failure. Retrying data that cannot become valid is just
  scheduled noise.
- Keep payloads small and identifier-based. Fetch current authoritative state inside the processor.
- Treat jobs as potentially duplicated, delayed and out of order.
- For a business-critical “DB commit must eventually enqueue” workflow, write a transactional outbox row in the same PostgreSQL transaction and relay it. A plain `commit(); queue.add()` has a crash gap.
- Correlation/request IDs travel in job data and logs. Never place secrets in job data; Bull Board and Redis operators can inspect it.

Default retention is bounded (`removeOnComplete` and `removeOnFail`) so Redis does not become a landfill with a dashboard attached. Bull Board is read-only, disabled by default, and requires credentials when enabled. Put it behind private networking/SSO in production even with Basic authentication.

## Health and observability

- `GET /api/v1/health/live` proves that the HTTP process is alive; it does not touch dependencies.
- `GET /api/v1/health/ready` checks PostgreSQL and a real BullMQ Redis operation. Remove an instance from traffic when this fails.
- `GET /api/docs` serves Swagger UI; `/api/openapi.json` and `/api/openapi.yaml` expose the contract.
- Bull Board is mounted under `/api/v1/admin/queues` by Nest's global prefix
  when enabled. Its module and route are absent when disabled, and its
  middleware receives credentials from the validated configuration contract
  rather than rereading raw `process.env`.

Pino emits JSON, propagates/creates `x-request-id`, redacts authorization/cookie/common secret fields, and attaches active OpenTelemetry trace/span IDs. Add redaction paths when a new endpoint introduces a sensitive field; logging it first and apologizing later is not observability.

Instrumentation is preloaded before Nest. Configure exactly one tracing path per process:

- `OTEL_EXPORTER_OTLP_ENDPOINT` for vendor-neutral OTLP, or
- `SENTRY_DSN` for the official NestJS Sentry SDK.

Environment validation rejects both at once to prevent duplicate auto-instrumentation. `OnApplicationShutdown` closes DB pools and telemetry exporters; Nest shutdown hooks handle `SIGTERM`/`SIGINT`.

The compiled application is ESM, but its currently instrumented Nest, Express,
BullMQ/ioredis, Pino and `pg` targets are CommonJS packages or ESM wrappers over
CommonJS. On 2026-07-22 an in-memory-exporter smoke produced Nest, Express, HTTP
and ioredis spans with the existing `node --import ./dist/instrumentation.js`
preload. Adding OpenTelemetry's experimental ESM loader produced the same spans
and an experimental Node warning, so it is deliberately absent. Re-run that
smoke and follow OpenTelemetry's ESM-loader guidance if a natively ESM
instrumented dependency is introduced; package format alone is not evidence
that a loader improves anything.

## Environment

`apps/backend/.env.example` lists every backend-specific variable. Direct commands run from `apps/backend` read that file when copied to `.env`; root `pnpm dev` injects the repository-root environment.

Required:

- `DATABASE_URL`

Defaults exist for `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `DATABASE_POOL_MAX`, `REDIS_URL`, `LOG_LEVEL`, `OTEL_SERVICE_NAME` and `SENTRY_TRACES_SAMPLE_RATE`. `WEB_ORIGIN` accepts a comma-separated list of HTTP(S) origins; entries are normalized and paths, credentials, query strings, fragments and empty entries are rejected. Optional/guarded variables are `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN`, `BULL_BOARD_*` and `REFERENCE_MODULE_ENABLED`.

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
- Nest releases: <https://github.com/nestjs/nest/releases>
- Nest first steps and Node requirement: <https://docs.nestjs.com/first-steps>
- Nest modules/providers: <https://docs.nestjs.com/modules>, <https://docs.nestjs.com/providers>
- Nest configuration and conditional modules: <https://docs.nestjs.com/techniques/configuration>
- Nest standalone worker contexts: <https://docs.nestjs.com/standalone-applications>
- Nest lifecycle/shutdown hooks: <https://docs.nestjs.com/fundamentals/lifecycle-events>
- Nest exception filters: <https://docs.nestjs.com/exception-filters>
- Nest BullMQ queues: <https://docs.nestjs.com/techniques/queues>
- Nest OpenAPI: <https://docs.nestjs.com/openapi/introduction>
- Nest's maintained TypeScript starter: <https://github.com/nestjs/typescript-starter>
- Express 5 migration guide: <https://expressjs.com/en/guide/migrating-5.html>
- Drizzle PostgreSQL: <https://orm.drizzle.team/docs/get-started-postgresql>
- Drizzle transactions: <https://orm.drizzle.team/docs/transactions>
- Drizzle Kit/migrations: <https://orm.drizzle.team/docs/kit-overview>
- Drizzle `generate` versus `push`: <https://orm.drizzle.team/docs/faq#should-i-use-generate-or-push>
- node-postgres pooling: <https://node-postgres.com/features/pooling>
- BullMQ idempotent jobs: <https://docs.bullmq.io/patterns/idempotent-jobs>
- BullMQ job IDs: <https://docs.bullmq.io/guide/jobs/job-ids>
- BullMQ retrying failures: <https://docs.bullmq.io/guide/retrying-failing-jobs>
- BullMQ unrecoverable failures: <https://docs.bullmq.io/patterns/stop-retrying-jobs>
- Bull Board and Nest adapter: <https://github.com/felixmosh/bull-board/tree/master/packages/nestjs>
- `nestjs-zod`: <https://github.com/BenLorantfy/nestjs-zod>
- Zod: <https://zod.dev/>
- `nestjs-pino`: <https://github.com/iamolegga/nestjs-pino>
- Pino redaction: <https://getpino.io/#/docs/redaction>
- OpenTelemetry Node.js: <https://opentelemetry.io/docs/languages/js/getting-started/nodejs/>
- OpenTelemetry package compatibility: <https://github.com/open-telemetry/opentelemetry-js#package-version-compatibility>
- OpenTelemetry instrumentation libraries and ESM notes: <https://opentelemetry.io/docs/languages/js/libraries/>
- Sentry NestJS SDK: <https://docs.sentry.io/platforms/javascript/guides/nestjs/>
- TypeScript 7 release and ecosystem constraints: <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- `dotenv`: <https://github.com/motdotla/dotenv>
- `reflect-metadata`: <https://github.com/microsoft/reflect-metadata>
- RxJS: <https://rxjs.dev/>
- Vitest: <https://vitest.dev/guide/>
