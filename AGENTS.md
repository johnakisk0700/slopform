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

- Root `package.json` scripts are the public command surface; keep dependency
  ordering, cache inputs and real generated outputs in `turbo.json`.
- The phases inside `pnpm check` run sequentially, fastest and most localized
  first: `format:check`, `docs:check`, `typecheck`, `lint`, `test`, then the full
  `build` last. This ordering exists to fail fast, not to serialize contended
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
