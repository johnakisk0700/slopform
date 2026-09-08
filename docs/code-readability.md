# Code readability and naming

User preferences captured on **2026-09-08**. Apply these while writing or
changing an operation. Examples explain the preference; they do not authorize
a new refactor or a repository-wide rename.

## Names that explain the operation

A reader should understand the action and what it affects from the complete
call. Prefer a familiar verb plus a concrete domain object; add scope when it
matters. The receiver can supply useful context, so repeating every noun is
not a goal.

| Unclear in its context               | Clearer example                                 | What becomes visible                                         |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `demoSandbox.ensureForUser(user.id)` | `demoSandbox.ensureDataForUser(user.id)`        | The method ensures demo data exists.                         |
| `initialize(user.id)`                | `initializeDataForUser(user.id)`                | The method initializes data for a user.                      |
| `proposalPolicy.check(proposal)`     | `replyEligibility.canCommitReply(proposal)`     | The decision concerns whether the AI reply may be committed. |
| `processEverything(input)`           | `feedbackService.recordParticipantReply(input)` | The operation records a participant's reply.                 |

These are illustrative names, not claims that these APIs exist or that a
boolean captures every current eligibility outcome. Preserve meaningful result
types when a caller must distinguish why work cannot proceed.

`ensure` is allowed. In the accepted demo example, `ensureDataForUser(user.id)`
means create missing initial data and preserve existing data. Document and
verify that repeated or concurrent calls do not reseed or reset the sandbox.
`initializeDataForUser` is also understandable; the important correction was
the missing object, `Data`, rather than a ban on a particular verb.

Avoid names whose meaning depends on knowing a private convention. Do not make
names longer when the receiver and parameters already make the call clear:
`transport.sendText(...)` and `campaignService.resume(...)` can be sufficient.

## Operations that read as a recipe

Expose meaningful stages with coherent functions or classes. Pick a function
for a value-based decision and a class for a mechanism with dependencies or a
protocol. A class per condition and a `Helper` suffix are not requirements.

The caller should reveal ordering, decisions and outcomes. SQL belongs in
domain repositories; the service that owns the complete business operation
owns its transaction. Entry methods can hide that transaction, while the
participating repositories still receive the same explicit transaction.

Use short stage comments to explain purpose, such as “Check whether the AI
reply is still eligible to be committed.” Avoid comments that only repeat the
next call, historical essays inside methods, or vague terms such as “proposal
policy” when the actual decision can be named. Keep longer rationale in docs.

Keep substantial types next to their owning mechanism. File length is a signal
to inspect responsibilities, not an acceptance target. Moving code into many
wrappers does not prove it is easier to understand. Keep small helpers, constants
and local hooks with their owner unless a separate file removes a substantial
responsibility from the reader's path. Reorganizing should also remove obsolete
commentary, redundant exports and unnecessary indirection.

## Simplicity is the default

Solve the current requirement with the most direct implementation. Do not add
extension points, options, adapters or fallback paths for hypothetical callers.
Use the language and installed libraries before writing another framework.

- The main operation reads as a recipe: named steps, visible decisions and
  ordering. Keep transactions and external side effects visible in that flow.
- Split files by cohesive responsibility. Extract a meaningful step when it
  makes the caller easier to read; a single caller is fine for a domain step.
  Avoid pass-through classes and files whose only job is forwarding arguments.
- Share a rule when real callers need the same behavior. Similar-looking code
  with different reasons to change need not share an abstraction. Do not copy
  a business rule just to avoid designing a small shared function.
- Validate untrusted data when it enters the application. Once parsed, use
  its type through the internal flow. Do not revalidate typed arguments,
  generated envelopes or responses assembled by our own code. External
  provider payloads, consumed jobs and untyped stored documents are incoming
  data too. Business checks against current state remain necessary.
- Tests protect consequential behavior: authorization, state transitions,
  persistence, retries, provider failures and regressions. Do not test source
  strings, exact utility classes, private wiring or the schema library itself.
  A reversible visual change does not need another test suite.
  Every retained case must name either a business contract or a mechanical
  guarantee and the failure it would catch. Constructing an object or listing
  registered providers is insufficient. Startup tests earn their place through
  observable failure, cleanup or availability behavior. A mock that implements
  a lock, retry or uniqueness rule cannot prove the real mechanism has it.
  In mixed suites, delete empty assertions and retain the meaningful cases;
  neither coverage percentages nor file counts are acceptance targets.
- Fewer lines are desirable when they remove work the reader must understand.
  Do not compress expressions, weaken types, hide errors or move complexity
  into generic utilities to improve the diff count.

Use this brief when delegating implementation:

> Implement the present requirement directly. Make the main operation read as
> a recipe of named domain steps. Split by responsibility, share actual rules,
> and avoid forwarding layers, speculative options and internal revalidation.
> Prefer existing language/library features. Keep meaningful behavior checks;
> remove implementation-mirroring tests. Explain any new abstraction with its
> current callers or concrete responsibility. Report what became simpler and
> how the resulting behavior was verified.

Before accepting a change, read the main operation and its callers. Check each
new abstraction, dependency, option and test against a current requirement.
Review removed checks for behavior they owned (normalization and business
invariants included). Run the applicable checks, then integrate. A green suite
and a negative line count do not substitute for this review.

## Scope and review

- The user's `extract`, STOP and profanity examples described a general
  organization preference. They are not a standing request to rewrite those
  mechanisms. Preserve the deliberately retained profanity behavior.
- Read critical operations and callers before accepting an agent's work.
  Report the resulting flow, verification and remaining uncertainty.
- A naming correction should update this convention when it teaches a general
  rule; do not spend a new work batch debating one example.
- Use native Codex agents for GPT/Astra and Cursor for Grok when delegation
  is authorized. No silent GPT fallback through Cursor.

For concrete feedback boundaries and recipes, read
[feedback code readability](backend/modules/post-event-feedback-readability.md).
For current priorities, read [the portfolio plan](portfolio-plan.md).
