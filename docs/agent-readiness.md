# Agent readiness benchmark

**Historical protocol and results from 2026-07-22.** Status then: foundation
target passed. This file is an evidence-style record of that exercise — not a
living how-to for today's stack.

The run predates the generated API client (ADR 0009/0010), the assistant module,
and the post-event feedback loop. By the rule at the bottom, a repeat is due
after those material changes. Names in the protocol (`useApi()`,
`admin-page-stack`) reflect what agents were told / what finding 2 proposed at
the time; they are not current contracts to hunt for.

## Protocol (as run 2026-07-22)

Fresh agents got an isolated detached worktree and the same task:

- validated, newest-first read endpoint on the gated reference module;
- admin list page via `useApi()` and `JtsDataTable`;
- loading, error, empty and populated states;
- preserve Nest/Drizzle, Zod, HeroUI, metadata and documentation contracts;
- no new dependency, migration, mutation or speculative abstraction.

Candidates did not commit. An independent Sol judge scored anonymous diffs:
architecture 2.0, correctness 2.0, frontend 2.0, minimality 1.5, tests/docs 1.5,
explanation/risk 1.0. Benchmark code was discarded.

## Results

| Run                         | Implementation | Foundation comfort | Result                                   |
| --------------------------- | -------------: | -----------------: | ---------------------------------------- |
| Terra, audited foundation   |       8.4 / 10 |           9.2 / 10 | Foundation passed; implementation missed |
| Sol, audited foundation     |       9.7 / 10 |           9.2 / 10 | Passed                                   |
| Terra, clarified guardrails |       9.3 / 10 |           9.4 / 10 | Passed                                   |

Threshold: `>= 9.0` on both scores. First Terra miss surfaced three
discoverability gaps (not a structural rewrite):

1. HTTP tests needed an explicit real-application recipe.
2. Admin pages needed a named `admin-page-stack` root contract (name did not survive).
3. Admin API parsing and HeroUI imports needed checklist wording.

Those clarifications produced a passing fresh Terra run without showing the first
diff. Luna was unavailable in the model set; no Luna result is claimed.

## Remaining evidence gaps (from that run)

- Copyable real-application HTTP/OpenAPI contract test when the first durable
  product route lands.
- Exercise ordering and migrations against disposable PostgreSQL.
- Route-level page-state tests when admin data flows stop being disposable scaffolding.
- ~~Node `>=24.11 <25`.~~ **Closed** — host used 24.7.0 with engine warnings;
  `package.json` now pins `>=24.11 <25`.

Repeat this benchmark after a material architecture change, not after ordinary
feature work. Scoring the tree every Tuesday turns a guardrail into ceremony.
