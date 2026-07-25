# API contract and generated client

Status: accepted, verified 2026-07-25 with `@nestjs/swagger` 11.4.6,
`nestjs-zod` 5.4.0, orval 8.23.0 and `@tanstack/react-query` 5.101.4.

## Purpose and boundary

One contract crosses the HTTP boundary: the OpenAPI document that
`@nestjs/swagger` builds from the controllers and their `nestjs-zod` DTOs. This
page owns how that document becomes a committed artifact and how the admin SPA
consumes it as generated, named, typed functions.

It owns:

- `apps/backend/src/infrastructure/openapi/openapi-document.ts` — the single
  definition of the published document, its fixed emit environment and its
  deterministic serialization;
- `apps/backend/src/cli/emit-openapi.ts` and `apps/backend/openapi/openapi.json`
  — the emit command and the committed artifact;
- `apps/admin/orval.config.ts`, `apps/admin/openapi.transformer.ts`,
  `apps/admin/src/lib/api-mutator.ts` and `apps/admin/src/api/generated/**` —
  the generation contract and its output;
- `scripts/verify-generated-api.mjs` — the drift check inside `pnpm check`.

It does not own transport policy (that is `apps/admin/src/lib/api.ts`, see
[Frontend foundation](../../frontend.md)), authorization (see
[Admin authentication](authentication.md)) or the HTTP edge configuration (see
[Runtime operations](runtime-operations.md)).

## Contract

| Artifact                            | Produced by                                  | Consumed by                                  |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `apps/backend/openapi/openapi.json` | `pnpm openapi:emit`                          | orval, contract review, external integrators |
| `src/api/generated/<tag>.ts`        | `pnpm api:generate`                          | admin routes and components                  |
| `src/api/generated/model/*.ts`      | `pnpm api:generate`                          | response and request types                   |
| `src/api/generated/zod/*.zod.ts`    | `pnpm api:generate`                          | hand-rolled validation of a value we persist |
| `/api/openapi.json` (runtime)       | `createHttpApplication()` outside production | Swagger UI at `/api/docs`, manual inspection |

Commands, all from the repository root:

| Command             | Effect                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `pnpm openapi:emit` | Builds the backend through Turbo, then rewrites the committed document |
| `pnpm api:generate` | Emits the document and regenerates the admin client from it            |
| `pnpm api:check`    | Regenerates and fails when anything changed; part of `pnpm check`      |

Operation names are the public API. Every operation declares
`@ApiOperation({ operationId })` in lower camel case; orval derives the exported
function (`getAuthSession`), the hook (`useGetAuthSession`), the query-key helper
(`getGetAuthSessionQueryKey`) and the Zod schema (`GetAuthSessionResponse`) from
it. Nest's default `AuthController_session` is rejected by a test, because it
leaks a class name into the client and renames itself during refactors.

## Flow

```mermaid
flowchart LR
  controllers["Controllers + nestjs-zod DTOs"] --> emit["openapi:emit\n(no server, fixed env)"]
  emit --> artifact["apps/backend/openapi/openapi.json"]
  artifact --> orval["orval (react-query + zod)"]
  orval --> generated["src/api/generated/**"]
  generated --> mutator["apiRequest mutator"]
  mutator --> client["ofetch api client\n(Clerk bearer, retry 0, 15s)"]
  artifact --> check["pnpm api:check\nregenerate and compare"]
```

## Invariants

- The emitted artifact is a function of source code alone. `emit-openapi.ts`
  applies `OPENAPI_EMIT_ENVIRONMENT` before importing the application module, so
  a developer's `.env` cannot change the published contract, and every object key
  is sorted before serialization so a new route produces a local diff.
- The published composition is the default one: the Wasender webhook, the
  reference module and Bull Board are off. Promoting one of them to a product
  surface means publishing it deliberately in that environment.
- The document the running process serves and the committed artifact are built by
  the same `createOpenApiDocument()`; a backend test asserts they are identical
  byte for byte.
- Generated code is never edited. It carries an orval header, is excluded from
  ESLint (so no autofix rewrites a file the next run overwrites) and is still
  typechecked by `tsc`.
- `apiRequest` is the only bridge between generated code and HTTP, and it adds no
  policy of its own — authentication, retries and timeouts stay in `api.ts`.
- Published paths keep the `/api` mount point; `openapi.transformer.ts` removes
  it at generation time because the client's `baseURL` (`env.apiBase`) owns it.
  A path outside `/api/` fails generation instead of silently producing a broken
  URL.

## Failure states

| Situation                                    | Behavior                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Controller changed, artifact not regenerated | `pnpm api:check` regenerates, lists the changed files and fails; `pnpm test` fails too             |
| Generated client edited by hand              | The next generation overwrites it and `pnpm api:check` fails                                       |
| Operation without an explicit `operationId`  | The OpenAPI document test fails before a class-derived hook name can reach the client              |
| Backend unbuildable                          | `pnpm api:check` prints the Turbo output and fails without touching the artifact                   |
| Request fails at runtime                     | The hook reports `isError`; the screen owns the denial/retry/failure state, as `RequireAdmin` does |

`pnpm api:check` leaves the regenerated files in place: a failure is an
instruction to review and commit them, never to hand-edit them.

## Extension points

Adding or changing an endpoint:

1. Change the controller, its Zod schemas and DTOs; declare
   `@ApiOperation({ operationId })` for a new operation.
2. Run `pnpm api:generate`; commit `openapi.json` and the generated client with
   the backend change.
3. Consume the new hook in the admin app. Do not write a Zod schema for a
   response that the document already describes.

The generated Zod schemas exist for values that leave the typed path — a form
draft, something persisted in the browser, a payload echoed back into a request.
Import them from `src/api/generated/zod/`; do not hand-copy a backend schema.

Three screens predate this pipeline and still parse responses with hand-written
schemas: the assistant (`features/assistant/`), whose polling flow owns extra
client-side semantics, and the WP1 events and participants screens
(`features/event/`, `features/participant/`). Their operations are published and
generated now, so each migrates to its hooks in its own change. New code does not
copy them.

## Operations and tests

- `apps/backend/src/infrastructure/openapi/openapi-document.spec.ts` — boots the
  real HTTP composition, compares the document with the committed artifact,
  requires explicit unique operation ids, requires the `/api/v1` prefix and
  asserts deterministic serialization.
- `apps/admin/test/generated-api-client.spec.ts` — the path transformer, one hook
  per published operation, every generated file routed through the mutator, the
  admin gate on the generated hook and the single `QueryClientProvider`.
- `pnpm api:check` runs between `docs:check` and `typecheck` in `pnpm check`, so
  the compiler, linter and tests always read a current client.
- Emitting opens no port and contacts no dependency: `NestFactory.create()` only
  instantiates providers, and `onModuleInit` — which opens the database pool —
  never runs.

## Decisions and references

- [ADR 0009](../../decisions/0009-generated-api-client.md) — generated client
  over hand-written response schemas.
- [Frontend foundation](../../frontend.md) — how admin screens consume the hooks.
- [Backend foundation](../../backend.md) — controller, DTO and slice conventions.
- [Nest OpenAPI](https://docs.nestjs.com/openapi/introduction) and
  [operation ids](https://docs.nestjs.com/openapi/operations)
- [orval configuration](https://orval.dev/reference/configuration/overview) and
  [custom mutators](https://orval.dev/guides/custom-axios)
- [TanStack Query v5](https://tanstack.com/query/latest/docs/framework/react/overview)
