# Backend agent contract

The repository `AGENTS.md` applies here. Before changing behavior, read
`docs/backend.md`, the relevant page under `docs/backend/mechanisms/`, and any
owning module page.

Controllers own transport, services own use-case ordering and transactions,
repositories own explicit persistence, and infrastructure adapters own provider
lifecycle. Keep HTTP providers out of the worker graph and worker providers out
of the HTTP graph.

## Change map

| Task                  | Primary files and required follow-through                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a module          | Add a domain module under `src/modules/`; wire HTTP providers in `http-app.module.ts`, workers in `worker-app.module.ts`, and document a durable product boundary under `docs/backend/modules/`. An **external provider boundary** goes under `src/integrations/` instead — `wasender` is the existing example — and is documented as a mechanism, not a module. |
| Add a route           | Change the domain controller, schemas and HTTP module; declare `@ApiOperation({ operationId })`, run `pnpm api:generate` from the repository root and commit the regenerated contract and admin client; test the response/error contract.                                                                                                                        |
| Add a DTO or payload  | Define one Zod contract in `<domain>.schemas.ts`; derive HTTP DTOs with `createZodDto` and pass schema-inferred plain types beyond the controller.                                                                                                                                                                                                               |
| Add persistence       | Put explicit queries in a domain repository. PostgreSQL changes use Drizzle schemas/migrations; MongoDB conversation changes use versioned Zod documents and reviewed indexes. Expose neither client to controllers.                                                                                                                                             |
| Add a transaction     | Let the application service call `DatabaseService.transaction()` and pass the same transaction to every repository and audit write. Repositories do not open hidden transactions.                                                                                                                                                                                |
| Add a queue job       | Define a versioned name and strict identifier-only envelope, validate at producer and consumer, choose retry/retention deliberately, and update `docs/backend/mechanisms/queues.md`.                                                                                                                                                                             |
| Add a worker          | Register processors only in a domain worker module imported by `worker-app.module.ts`; add a composition test proving HTTP/producer providers did not leak in.                                                                                                                                                                                                   |
| Add configuration     | Extend `infrastructure/config/environment.ts` and its tests, then update applicable example/deployment configuration and `docs/backend/mechanisms/runtime-operations.md`. Do not scatter `process.env` reads through services.                                                                                                                                   |
| Change logs or traces | Change `infrastructure/logging/`, `instrumentation.ts` or `infrastructure/observability/`; preserve redaction, single-tracer ownership and shutdown flushing, then update the runtime mechanism page.                                                                                                                                                            |
| Add a migration       | Change the Drizzle schema, generate named SQL and metadata under `packages/database/drizzle/`, review locks/data effects, run `db:check`, and update the database mechanism page.                                                                                                                                                                                |
| Add a test            | Co-locate a focused `*.spec.ts`; HTTP routes build the real application as described under "Environment and operation" in `docs/backend.md`; adapter semantics use real PostgreSQL/Redis with bounded, exact cleanup rather than mocked fluent internals.                                                                                                        |

**There is no ESLint in this workspace.** `pnpm lint` here is
`tsc -p tsconfig.json --noEmit`, byte-identical to `typecheck`. A green `lint`
says the types hold, not that any style rule passed — so style is carried by
review and by matching the surrounding code, not by a tool.

The published OpenAPI contract lives in `apps/backend/openapi/openapi.json` and
is emitted from source by `pnpm openapi:emit`; the admin client is generated from
it. Never edit either by hand, and read
[`docs/backend/mechanisms/api-contract.md`](../../docs/backend/mechanisms/api-contract.md)
before changing how the document is built.

Update diagrams, invariants, failure behavior, configuration, job/API contracts
and operational checks with the code. Document stable boundaries, not every
class; a page-per-provider is filing bureaucracy wearing a lanyard.
