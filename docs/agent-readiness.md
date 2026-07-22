# Agent readiness benchmark

Status: passed foundation target on 2026-07-22.

This is a repeatable extension exercise, not a model-vendor benchmark. It tests
whether the repository makes a small vertical slice easy to place, implement,
verify and explain without prior conversation context.

## Protocol

Fresh agents received only an isolated detached worktree and the same task:

- add a validated, newest-first read endpoint to the gated reference module;
- add an admin list page through `useApi()` and `JtsDataTable`;
- cover loading, error, empty and populated states;
- preserve Nest/Drizzle, Zod, PrimeVue, metadata and documentation contracts;
- add no dependency, migration, mutation or speculative abstraction.

Candidates did not commit. An independent fresh Sol judge reviewed anonymous
diffs with this fixed rubric: architecture 2.0, correctness 2.0, frontend 2.0,
minimality 1.5, tests/docs 1.5 and explanation/risk awareness 1.0. Benchmark code
was discarded after review.

## Results

| Run                         | Implementation | Foundation comfort | Result                                   |
| --------------------------- | -------------: | -----------------: | ---------------------------------------- |
| Terra, audited foundation   |       8.4 / 10 |           9.2 / 10 | Foundation passed; implementation missed |
| Sol, audited foundation     |       9.7 / 10 |           9.2 / 10 | Passed                                   |
| Terra, clarified guardrails |       9.3 / 10 |           9.4 / 10 | Passed                                   |

The acceptance threshold is `>= 9.0` for both implementation and foundation
comfort. The first Terra result exposed three discoverability gaps rather than
a structural rewrite:

1. HTTP tests needed an explicit real-application recipe.
2. Admin pages needed a named, documented `admin-page-stack` root contract.
3. Admin API parsing and local PrimeVue imports needed checklist-level wording.

Those changes produced a passing fresh Terra run without showing it the first
diff or its score. Luna was not available in the configured model set, so no
Luna result is claimed.

## Remaining evidence gaps

- Add a copyable real-application HTTP/OpenAPI contract test when the first
  durable product route lands. Prose is clear, but executable precedent is
  harder to misread.
- Exercise repository ordering and migrations against disposable PostgreSQL;
  service mocks cannot prove adapter semantics.
- Add route-level page-state tests when admin data flows stop being disposable
  scaffolding.
- Run canonical checks on Node `>=24.11 <25`. The benchmark host used Node
  24.7.0 and emitted engine warnings, although focused checks passed.

Repeat this benchmark after a material architecture change, not after ordinary
feature work. Optimizing a codebase for a score every Tuesday is how a useful
guardrail becomes ceremonial furniture.
