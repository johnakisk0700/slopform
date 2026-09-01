# Backend agent contract

The repository `AGENTS.md` applies here. Before changing behavior, read
[`docs/backend.md`](../../docs/backend.md), the relevant
`docs/backend/mechanisms/` page, and any owning module page.

Controllers own transport; services own use-case ordering and transactions;
repositories own explicit persistence; infrastructure adapters own provider
lifecycle. Keep HTTP providers out of the worker graph and vice versa.

## Change map

| Task                  | Primary files and required follow-through                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add a module          | Domain module under `src/modules/`; wire HTTP in `http-app.module.ts`, workers in `worker-app.module.ts`; document under `docs/backend/modules/`. External provider boundaries live under `src/integrations/` (e.g. `wasender`) and are documented as mechanisms, not modules. |
| Add a route           | Domain controller, schemas, HTTP module; `@ApiOperation({ operationId })`; `pnpm api:generate` from repo root; commit regenerated `apps/backend/openapi/openapi.json` only (admin client is gitignored — ADR 0010); test response/error contract.                              |
| Add a DTO or payload  | One Zod contract in `<domain>.schemas.ts`; `createZodDto` for HTTP DTOs; schema-inferred plain types beyond the controller.                                                                                                                                                    |
| Add persistence       | Explicit queries in a domain repository. PostgreSQL: Drizzle schemas/migrations. MongoDB conversations: versioned Zod documents + reviewed indexes. Expose neither client to controllers.                                                                                      |
| Add a transaction     | Service calls `DatabaseService.transaction()` and passes that tx to every repository and audit write. Repositories never open hidden transactions.                                                                                                                             |
| Add a queue job       | Versioned name, identifier-only envelope, validate at producer and consumer, deliberate retry/retention; update `docs/backend/mechanisms/queues.md`.                                                                                                                           |
| Add a worker          | Processors only in a domain worker module imported by `worker-app.module.ts`; composition test that HTTP/producer providers did not leak in.                                                                                                                                   |
| Add configuration     | Extend `infrastructure/config/environment.ts` (+ tests); update example/deployment config and `docs/backend/mechanisms/runtime-operations.md`. No scattered `process.env` in services.                                                                                         |
| Change logs or traces | `infrastructure/logging/`, `instrumentation.ts`, or `infrastructure/observability/`; keep redaction, single-tracer ownership, shutdown flushing; update the runtime mechanism page.                                                                                            |
| Add a migration       | Drizzle schema → named SQL/metadata under `packages/database/drizzle/`; review locks/data effects; `db:check`; update the database mechanism page.                                                                                                                             |
| Add a test            | Co-locate focused `*.spec.ts`. HTTP routes build the real app (see "Environment and operation" in `docs/backend.md`). Adapter semantics: real PostgreSQL/Redis with bounded exact cleanup, not mocked fluent internals.                                                        |

**No ESLint here.** `pnpm lint` ≡ `typecheck` (`tsc -p tsconfig.json --noEmit`).
Style is review + matching surrounding code.

OpenAPI: commit `apps/backend/openapi/openapi.json` only — emitted by
`pnpm openapi:emit` / `pnpm api:generate`. Never edit by hand; see
[`api-contract.md`](../../docs/backend/mechanisms/api-contract.md).

Update docs with the code for diagrams, invariants, failure behavior,
configuration, job/API contracts and operational checks. Document stable
boundaries, not every class.
