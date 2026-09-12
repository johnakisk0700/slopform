# Portfolio planning reset

Last updated: **2026-09-12**.

The Slopform survey/workshop-feedback portfolio plan is retired. Its Notion
project and task database were moved to trash at the owner's request. The
previous release queue, questionnaire/scenario work, campaign-analysis UI,
and voice integration are not active portfolio tasks.

## New direction

The [new booking plan in Notion](https://app.notion.com/p/3d95e2e6ab7e81e49b91f36bb2ac1e4e)
owns the next product's scope and task status. It lives under
[Portfolio](https://app.notion.com/p/3d45e2e6ab7e8165b51fc1164cb09c44).

Create a clean repository in a **separate session**. The name remains open:
slop-in, Slopendar, SlopSlot. Keep the slop identity and existing logo. Read and
reuse only code needed by the selected flow; do not transplant this monorepo
or its survey/clustering backlog.

The first slice is group-session creation, booking N places, and a matching
roster/availability view. The first public demo adds synthetic visitor data,
isolation, reset, and a labelled demo inbox. Cancellations/transfers,
waitlist/jobs, and chat/tools follow as separate slices.

The bento-portfolio job-search queue prioritizes three usable CV variants and
resuming applications. Those do not wait for this demo. The twelve days
discussed were already elapsed delay, not a new build deadline.

## Existing repository

This reset changes planning only. Source, tests, current runtime contracts and
accepted ADRs remain the record of the existing implementation. See the
[feedback module](backend/modules/post-event-feedback.md),
[campaign topic analysis](backend/modules/campaign-topic-analysis.md) and
[readability guide](code-readability.md) when inspecting or reusing code.
Earlier showcase plans and implementation checkpoints are historical context;
they do not reactivate the retired backlog.
