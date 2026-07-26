# Repository agent contract

These instructions apply to every agent and every directory in this repository.
Nested `AGENTS.md` files add area-specific rules; they do not cancel this file.

## Documentation is part of the implementation

`docs/` is the maintained project memory, not a post-delivery scrapbook. Every
agent must keep it accurate in the same change that alters the code.

Before changing an area:

1. Read `docs/README.md`.
2. Read the relevant frontend/backend handbook, mechanism or component page.
3. Read linked ADRs and official library documentation when the change depends
   on framework or library behavior.

Before finishing, perform a documentation-impact check. Update `docs/` when a
change affects any of the following:

- architecture, data flow, ownership or runtime boundaries;
- a public/reusable component contract;
- a backend mechanism, job contract, retry or failure behavior;
- configuration, environment variables, operations or deployment;
- a dependency choice, supported version or extension convention;
- an accepted decision or a previous documented assumption.

Code, tests and current configuration are the operational source of truth. If
they disagree with the docs, reconcile them in the same change; do not preserve
fiction for historical politeness. Record superseded architectural decisions in
an ADR instead of silently rewriting their history.

## Documentation shape

- Keep `docs/README.md` as the routing index.
- Put frontend component contracts under `docs/frontend/components/`.
- Put backend cross-cutting flows under `docs/backend/mechanisms/`.
- Put durable architectural decisions under `docs/decisions/`.
- Link to source paths and official docs instead of duplicating large APIs.
- Record the relevant package version and verification date for library-specific
  guidance.
- Use Mermaid for flows with multiple actors, state transitions, retries or
  ownership boundaries. Keep diagrams small enough to understand without a
  magnifying glass and a theology degree.

Each mechanism/component document should cover only the applicable sections:
purpose, boundary, public contract, simple Mermaid flow, invariants, failure and
loading states, extension points, configuration/observability, tests, decisions
and official references. Use `docs/documentation-standard.md` as the template.

## The API contract is generated, not retyped

The backend's OpenAPI document is the only description of the HTTP boundary.
`apps/backend/openapi/openapi.json` is committed, and `apps/admin/src/api/generated/`
is generated from it with orval.

- Admin features call backend endpoints through the generated TanStack Query
  hooks (`useGetAuthSession`, …). Do not hand-write a fetch call, a URL string,
  or a response Zod schema for an endpoint that exists in the document.
- Every operation declares `@ApiOperation({ operationId })` in lower camel case;
  that name becomes the generated function, hook, query key and Zod schema.
- Changing an endpoint means running `pnpm api:generate` and committing the
  regenerated artifact and client in the same change. `pnpm api:check` runs
  inside `pnpm check` and fails on drift.
- Generated files are never edited by hand, and no generated call may bypass the
  `apiRequest` mutator that wraps the single `ofetch` client.

The pipeline is documented in
[`docs/backend/mechanisms/api-contract.md`](docs/backend/mechanisms/api-contract.md)
and [ADR 0009](docs/decisions/0009-generated-api-client.md).

## Frontend component selection

When building UI, use this order:

1. Search the existing project `Jts*` components and their inventory docs; reuse
   or extend a suitable component.
2. If none fits, use a HeroUI primitive directly.
3. If the same product pattern recurs, compose a narrowly reusable, documented
   `Jts*` component from HeroUI primitives and record its contract.
4. Use semantic HTML/CSS when neither the project library nor HeroUI provides the
   required semantics.

Do not wrap HeroUI merely to rename its props. Reusable project components should
own useful product behavior such as consistent loading/empty/error states,
pagination, accessibility or layout—not speculative abstraction.

## Repository workflow

- Use `pnpm db:query` for direct inspection of local PostgreSQL, MongoDB or
  Redis. It targets the Docker Compose services and is read-only by default;
  exact mutation commands require `--write`. Read
  `docs/backend/mechanisms/local-data-query.md` before changing local data.
- Root `package.json` scripts are the public command surface; keep dependency
  ordering, cache inputs and real generated outputs in `turbo.json`.
- The phases inside `pnpm check` run sequentially, fastest and most localized
  first: `format:check`, `docs:check`, `api:check`, `typecheck`, `lint`, `test`,
  then the full `build` last. `api:check` regenerates the API contract and the
  admin client and fails on any difference, so every later phase reads a current
  client. This ordering exists to fail fast, not to serialize contended
  state. Turbo owns dependency ordering and caching: every `typecheck`, `lint`,
  `test` and `build` task waits on its workspace dependencies' `build` (`^build`),
  so `@join-the-six/design-tokens` is built before the apps consume it. The admin
  app is a plain Vite/`tsc -b` build with no shared generated state; reorder the
  phases only if the fail-fast intent survives.
- Declare environment variables needed by persistent Turbo tasks explicitly.
  Do not pass the entire host environment through to every workspace.
- Internal dependencies use `workspace:*`. Update `pnpm-lock.yaml` with manifest
  changes, and review exact `allowBuilds` entries for new dependency scripts.
- CI may verify a clean install, repository checks and production packaging. It
  does not own deployment or production credentials.

## Definition of done

A change is not complete until relevant code, focused tests, documentation and
verification agree. Run the narrow checks while iterating and `pnpm check`
before handoff when the change spans packages or shared conventions.
