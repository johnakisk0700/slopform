# ADR 0010: Generated admin client is not committed

- Status: Accepted
- Date: 2026-07-26
- Supersedes: the "committed generated directory" consequence of
  [ADR 0009](0009-generated-api-client.md). The rest of ADR 0009 stands.

## Decision

`apps/admin/src/api/generated/` is produced on demand from the committed OpenAPI
contract and is not tracked in git.

- **Contract stays committed:** `apps/backend/openapi/openapi.json` remains the
  review signal and the sole committed description of the HTTP boundary.
- **Client is local output:** orval writes `apps/admin/src/api/generated/` from
  that document plus `apps/admin/orval.config.ts`. The directory is gitignored.
- **Drift check:** `pnpm api:check` regenerates and fails only when
  `openapi.json` changed. The client is produced as a side effect, not compared.
- **Build graph:** Turbo caches `api:generate` with
  `outputs: ["apps/admin/src/api/generated/**"]`. Admin `typecheck`, `lint`,
  `test` and `build` depend on `api:generate`, so a fresh clone regenerates
  before those phases.

## Why

- The client is a deterministic function of the committed contract and the
  orval config. Committing it duplicated ~166 files and ~13k lines of review
  noise without adding safety the contract file does not already give.
- ADR 0009's review goal was a visible contract change. One OpenAPI document
  does that; the generated TypeScript trees do not.

## Consequences

- Changing an endpoint means running `pnpm api:generate` and committing the
  regenerated `openapi.json` with the backend change. The client is not
  committed.
- Fresh clones and clean worktrees must run generation before admin typecheck,
  lint, test or build; Turbo `dependsOn` and `pnpm api:check` (inside
  `pnpm check`) own that.
- Generated files remain never hand-edited. A stray local edit disappears on
  the next generation instead of surviving in a diff.

## References

- [ADR 0009](0009-generated-api-client.md) — generated client over hand-written
  response schemas (still in force except the committed-directory consequence).
- [API contract and generated client](../backend/mechanisms/api-contract.md)
