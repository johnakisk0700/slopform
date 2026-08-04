# Overview screen

Status: implemented. Last verified: **2026-08-05**.

`/admin` is the operator landing page. It reads exact platform aggregates from
`useGetOverview` (`GET /api/v1/overview`) and keeps the existing Operations
visual vocabulary: `JtsStat`, focus cards, ledger stamps, ruled attention rows
and a copper note for the snapshot age.

## Behaviour

- Header **Refresh** lives in `JtsPageHeader` `actions` (top-right). It calls
  `refetch()`; the glyph spins while a background refresh is in flight.
- Stats: scheduled events, participants (with feedback-contactable detail),
  conversations needing attention, undelivered outbound messages. The four
  cards remain a compact two-by-two summary below the `sm` breakpoint, then
  expand to two and four columns at the existing desktop breakpoints.
- Focus: next scheduled dinner (attendee assignments, venue label) and an
  operator queue built from unresolved attention reasons, extraction parked,
  ambiguous/held outbox, failed summaries, and finished dinners without a
  campaign.
- Lower strip: event status counts and feedback-loop completion (campaigns,
  conversations, completed, summaries ready, present/assigned).
- Loading, error and empty-next-dinner states are honest. There is no local
  preview data and no create-event modal on this page.

Source: [`OverviewPage.tsx`](../../apps/admin/src/routes/OverviewPage.tsx).
Backend contract: [overview module](../backend/modules/overview.md).
