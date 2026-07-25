# ADR 0009: Generated admin API client

- Status: Accepted
- Date: 2026-07-25

## Decision

The admin SPA consumes the backend through a client generated from the backend's
own OpenAPI document. Hand-written response schemas for endpoints that the
document describes are removed and forbidden.

- **Contract artifact:** `apps/backend/openapi/openapi.json`, written by
  `pnpm openapi:emit` from `SwaggerModule.createDocument()` without starting a
  server, with a fixed environment and sorted keys so it is deterministic.
- **Generator:** orval 8, producing TanStack Query hooks and Zod schemas from the
  same document into `apps/admin/src/api/generated/`.
- **Names:** every operation declares `@ApiOperation({ operationId })`; the
  generated function, hook, query key and Zod schema derive from it.
- **Transport:** a custom orval mutator (`src/lib/api-mutator.ts`) delegates to
  the existing `ofetch` client, which stays the single transport seam.
- **State:** `@tanstack/react-query` 5 with one `QueryClientProvider` at the app
  root; retries stay off in both directions, matching `retry: 0` on the client.
- **Drift:** `pnpm api:check` regenerates and fails on any difference; it runs
  inside `pnpm check`.

## Why

- `docs/frontend.md` previously told every screen to treat responses as `unknown`
  and re-declare a Zod schema per feature, with a generated client deferred until
  the contract stabilized. That duplicated each DTO by hand, and the duplicate
  can disagree with the backend without anything failing.
- The backend already derives DTOs from Zod through `nestjs-zod`, so the OpenAPI
  document is not a second source of truth; it is a projection of the existing
  one.
- orval generates hooks and Zod schemas from one document, supports a custom
  mutator, and emits plain files we read in review — no runtime client library,
  no proxy magic. openapi-typescript would have given types without hooks, and a
  shared contract package would have coupled the SPA to backend TypeScript
  builds.
- A committed artifact makes a contract change visible in review, which a
  build-time fetch from a running server cannot do.

## Consequences

- The generated directory is committed, excluded from ESLint, still typechecked,
  and never hand-edited.
- Adding an endpoint means adding an `operationId` and running
  `pnpm api:generate` in the same change; `pnpm check` gained an `api:check`
  phase between `docs:check` and `typecheck`.
- `apps/admin/src/features/auth/schema.ts` is deleted; `RequireAdmin` uses
  `useGetAuthSession`. Events and participants screens use the generated hooks.
  The assistant still keeps hand-written schemas because it owns client-side
  semantics beyond the response shape.
- The published contract describes the default composition: the Wasender webhook,
  the reference module and Bull Board are off. Publishing one of them is a
  deliberate change to the emit environment.
- Generated hooks are typed, not validated at runtime. Responses are already
  serialized through the backend's Zod schemas; when a value must be re-validated
  in the browser, the generated Zod schema is used instead of a new hand-written
  one.

## Verified versions

Checked 2026-07-25 against `apps/backend/package.json` and
`apps/admin/package.json`.

| Dependency              | Version | Reference                                      |
| ----------------------- | ------- | ---------------------------------------------- |
| `@nestjs/swagger`       | 11.4.6  | <https://docs.nestjs.com/openapi/introduction> |
| `nestjs-zod`            | 5.4.0   | <https://github.com/BenLorantfy/nestjs-zod>    |
| orval                   | 8.23.0  | <https://orval.dev>                            |
| `@tanstack/react-query` | 5.101.4 | <https://tanstack.com/query/latest>            |

## References

- [API contract and generated client](../backend/mechanisms/api-contract.md) —
  the mechanism page.
- [ADR 0006](0006-react-admin-runtime.md) — the React admin runtime this extends.
