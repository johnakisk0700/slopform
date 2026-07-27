# History

Plans that have been carried out, and snapshots taken along the way.

**Nothing here describes the system as it is now.** Every file was written to
argue for work that has since been done, so reading one as instruction produces
code that already exists, or code the execution deliberately did differently.
When these disagree with the code, the code is right and this directory stays
unchanged — it is a record, not a document to maintain.

Read one only to answer "why is it like this", and prefer the ADR if there is
one: [`../decisions/`](../decisions/0001-platform.md) records what was decided,
where these record what was proposed.

| Record                                                                       | What it was for                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [post-event feedback plan](post-event-feedback-plan-2026-07-25.md)           | The implementation plan for the feedback module                        |
| [conversation loop remediation](post-event-feedback-loop-plan-2026-07-26.md) | Thirty defects found once real conversations ran, and the fix for each |
| [agent briefs](post-event-feedback-agent-briefs-2026-07-25.md)               | The dispatch prompts that built the module, one per work package       |
| [design handover](post-event-feedback-handover-2026-07-25.md)                | A portable snapshot of the design while it was still being settled     |
| [consolidation plan](consolidation-plan-2026-07-26.md)                       | The 45-packet refactor that produced the current module layout         |

## Why they are kept

The consolidation plan is the clearest argument for keeping this directory: it
records that four packets were refused by the agents executing them, that two
apparent duplicates turned out to be load-bearing, and that three of its own
targets were unreachable as written. That reasoning is worth more than the plan
was, and none of it is recoverable from the resulting code.
