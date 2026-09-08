# ADR 0020: Use async functions for serial workflows

- Status: Accepted
- Date: 2026-09-08
- Supersedes: [ADR 0017](0017-effect-for-local-workflows.md).

## Decision

Feedback extraction and topic analysis use direct `async`/`await`. Their
sequential calls need no Effect conversion or generic Promise adapter.
Extraction catches capacity failures only around the commit transaction;
admission, model and notification failures still propagate unchanged.

Keep Effect where it owns a concrete resource scope: the topic-clustering
subprocess uses `acquireRelease` to stop and reap the child on success, failure,
cancellation and shutdown. Create and run that scope in the adapter itself.
Nest owns application lifecycle and BullMQ owns retries. No new concurrency,
retry or cancellation behavior is introduced.

## Verification

Extraction scenarios cover commit-only capacity recovery and post-commit
failures. Topic-analysis tests cover claim settlement; subprocess tests cover
bounded output, cancellation and cleanup. Typecheck and build cover the direct
Promise flows.
