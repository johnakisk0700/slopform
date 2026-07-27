# Repository agent contract

This file is loaded for every change in this repository, so it stays short and
mostly points elsewhere. Nested `AGENTS.md` files add area rules; they never
cancel this one.

## Read what your change touches, and only that

`docs/` is the project's memory. Do not read it end to end — find your row.

| Changing                      | Read first                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any HTTP endpoint or DTO      | [api-contract](docs/backend/mechanisms/api-contract.md)                                                                                                        |
| anything under `apps/admin`   | [apps/admin/AGENTS.md](apps/admin/AGENTS.md), then [frontend](docs/frontend.md)                                                                                |
| anything under `apps/backend` | [apps/backend/AGENTS.md](apps/backend/AGENTS.md), then [backend](docs/backend.md)                                                                              |
| post-event feedback           | [the module](docs/backend/modules/post-event-feedback.md), and [its scenarios](docs/backend/modules/post-event-feedback-scenarios.md) before touching the loop |
| the AI assistant              | [assistant module](docs/backend/modules/assistant.md), [assistant screen](docs/frontend/assistant.md)                                                          |
| queues, jobs, retries         | [queues](docs/backend/mechanisms/queues.md)                                                                                                                    |
| conversation storage          | [mongodb](docs/backend/mechanisms/mongodb.md), [ADR 0007](docs/decisions/0007-mongodb-conversation-authority.md)                                               |
| sign-in or authorization      | [authentication](docs/backend/mechanisms/authentication.md)                                                                                                    |
| WhatsApp delivery             | [wasender](docs/backend/mechanisms/wasender.md)                                                                                                                |
| colors, spacing, type         | [theming](docs/frontend/theming.md) — never hardcode a value a token owns                                                                                      |
| a reusable `Jts*` component   | [component inventory](docs/frontend/components/README.md)                                                                                                      |
| schema or migrations          | [database](docs/backend/mechanisms/database.md)                                                                                                                |
| local data, by hand           | [local-data-query](docs/backend/mechanisms/local-data-query.md) — read it before writing anything                                                              |
| containers or the VPS         | [deployment](docs/deployment.md)                                                                                                                               |
| shutdown, health, logging     | [runtime-operations](docs/backend/mechanisms/runtime-operations.md)                                                                                            |

Two directories are records, not instructions. **Never build from them.**
[`docs/history/`](docs/history/README.md) holds plans already carried out —
following one produces code that exists, or work the execution deliberately did
differently. [`docs/evidence/`](docs/evidence/README.md) holds audits fixed to a
date. Read either only to answer "why is it like this", and prefer the
[ADR](docs/decisions/0001-platform.md) when one exists.

## Documentation is part of the change

Update `docs/` in the same commit that makes the change true, whenever it
affects architecture, ownership or a runtime boundary; a reusable component
contract; a job, retry or failure behavior; configuration or deployment; a
dependency choice; or a documented assumption.

Code, tests and configuration are the operational truth. Where docs disagree,
fix the docs in that same change — do not leave fiction standing out of
politeness. Supersede an accepted decision with a new ADR rather than editing
the old one. [`documentation-standard.md`](docs/documentation-standard.md) is
the template and says where each kind of page belongs.

## The API contract is generated, not retyped

`apps/backend/openapi/openapi.json` is the only description of the HTTP
boundary, and it is committed. `apps/admin/src/api/generated/` is produced from
it by orval and is **not** committed
([ADR 0010](docs/decisions/0010-generated-client-not-committed.md)).

- Call endpoints through the generated hooks. Never hand-write a fetch, a URL
  string or a response schema for an operation the document already describes.
- Every operation declares `@ApiOperation({ operationId })` in lower camel case;
  that name becomes the function, hook, query key and Zod schema.
- Changing an endpoint means running `pnpm api:generate` and committing the
  regenerated `openapi.json`. `pnpm api:check` fails on drift.
- Never edit generated output, and never bypass the `apiRequest` mutator around
  the single `ofetch` client.

## Repository workflow

- Root `package.json` scripts are the public command surface; ordering, cache
  inputs and real outputs belong in `turbo.json`.
- `pnpm check` runs fastest-first: `format:check`, `docs:check`, `api:check`,
  `typecheck`, `lint`, `test`, `build`. Reorder only if fail-fast survives.
- **`typecheck` and `build` do not cover the same files.** `tsconfig.build.json`
  excludes specs and harnesses, so a broken type in a harness appears only in
  `typecheck`; `declaration: true` and `exactOptionalPropertyTypes: true`
  produce errors that appear only in `build`. Vitest checks no types at all.
  Green tests plus a green build is not a green tree.
- Internal dependencies use `workspace:*`. Update `pnpm-lock.yaml` with manifest
  changes and review `allowBuilds` entries for new dependency scripts.
- Declare the environment variables a persistent Turbo task needs. Do not pass
  the host environment to every workspace.

## Definition of done

Code, focused tests, documentation and verification agree. Run the narrow check
while iterating and `pnpm check` before handoff.
