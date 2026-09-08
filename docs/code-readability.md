# Code readability and naming

User preferences captured on **2026-09-07**. Apply these while writing or
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
wrappers does not prove it is easier to understand.

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
