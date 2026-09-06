# ADR 0017: Effect utilities for local workflow composition

- Status: Accepted
- Date: 2026-09-06
- Scope: Backend workflow composition, initially feedback extraction.

## Decision

Use Effect **3.22.1** for local async recipes where its composition and error
utilities make the operation easier to follow. Nest remains the dependency
injection and lifecycle owner. Do not introduce Effect `Tag`, `Context`,
`Layer`, implicit transactions, or a second workflow runtime around the workers.
Domain mechanisms keep their existing typed inputs and Promise APIs.

The first use is the extractor's `Effect.gen` recipe: admit a snapshot, plan
the AI turn, commit it, then notify. `Effect.either` exposes the commit outcome
locally, so only a capacity failure from that transaction invokes the separate
human brake. Admission, model, notification and brake failures still propagate.

The small [Promise boundary](../../apps/backend/src/infrastructure/effect/promise.ts)
adapts rejected values and synchronous service throws without wrapping them.
It runs a recipe once with `runPromiseExit` and rethrows the original failure
using `Cause.squash`; Nest and BullMQ still receive the same error instance.
This boundary is for a recipe with one failure path. A future concurrent flow
with multiple failures must define how to expose its full cause before reuse.

## Ownership and limits

- Nest creates collaborators; no service is looked up through an Effect context.
- The commit service opens the transaction and passes it explicitly to writers
  and repositories. Model calls and notifications stay outside that transaction.
- BullMQ retains retry and durable wake-up ownership. This adoption adds no
  `Effect.retry`, timeout, fork, cancellation or new provider retry behavior.
- Parallel extraction and attention calls retain `Promise.all`: a rejection
  fails the step while the sibling can finish. Do not silently replace this
  with Effect concurrency and interrupt a paid call.
- Logging observes named stages; it cannot authorize a write, replace an error,
  or choose recovery. Durable audit and outbox history keep their transaction.

## Why and verification

Prefer established library composition over a custom pipeline executor. The
readability improvement still comes primarily from cohesive domain mechanisms,
clear names and short comments explaining each stage's purpose. Ordinary
`async` functions remain appropriate when no composition utility helps.

Verified package metadata on 2026-09-06: Effect 3.22.1 is the stable release
selected for this change; Effect and the added `fast-check` / `pure-rand`
dependencies use MIT licenses and require no install build scripts. The backend
pins the version exactly. No configuration or deployment change is required.

Boundary tests cover lazy single execution, original rejected values and sync
throws. Extraction scenarios cover commit-only capacity recovery, suppression,
terminal identity, observational logging and post-commit failures. Run focused
tests during changes and `pnpm check` for the integrated tree.

## References

- [Effect v3 generators](https://effect.website/docs/v3/getting-started/using-generators)
- [Effect v3 expected errors](https://effect.website/docs/v3/error-management/expected-errors)
- [Readability guide](../backend/modules/post-event-feedback-readability.md)
- [Queue ownership](../backend/mechanisms/queues.md)
