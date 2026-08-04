# JtsPageHeader

`JtsPageHeader` renders one admin route's single `h1` with the six-dot title
mark, an optional back link, an optional wine eyebrow, a muted description and a
route-owned actions row. It owns the responsive title hierarchy and the order
those parts appear in — not metadata, breadcrumbs, fetching or the page entrance
animation (that lives in `AdminShell`'s main region).

Source: [`JtsPageHeader.tsx`](../../../apps/admin/src/components/ui/JtsPageHeader.tsx)

## Contract

| Prop          | Type                             | Contract                                                          |
| ------------- | -------------------------------- | ----------------------------------------------------------------- |
| `title`       | `string`                         | Required. The page's only `h1`; carries the six-dot mark beneath. |
| `back`        | `{ to: string; label: string }?` | A `JtsBackLink` above the eyebrow. Detail screens only.           |
| `eyebrow`     | `string?`                        | Tracked wine micro-caps kicker rendered above the title.          |
| `description` | `string?`                        | Muted supporting sentence under the title (max ~65ch).            |
| `actions`     | `ReactNode?`                     | Route-owned controls/links top-right of the header row.           |

The mark is the `jts-title-mark` utility in `globals.css`: six 3px dots on a 6px
pitch, five in `--jts-color-primary` and the sixth in `--jts-color-accent` — the
table and the seat still open, the same sentence `BrandMark` says with a chair.
It is motif 1 from the design contract, it means "this is a page title", and it
is static: a title mark that pulsed would be claiming something happened.

`back` is a prop rather than a route's own markup because _where_ the exit sits
was the part screens kept disagreeing on — two put it above the title, one filed
it under `actions` among the buttons that act on the page. See
[`jts-back-link.md`](jts-back-link.md).

## Scale

The title is a fixed `1.375rem` display weight, the description `text-sm`, the
eyebrow the shared `jts-overline` recipe (`--jts-text-2xs`). It is deliberately
not a viewport clamp. An operations panel is read at one working size for a whole
shift, so a title that grew toward `2.6rem` on a wide monitor spent height on
itself that the tables, transcripts and forms below it needed. Letter-spacing comes from the base layer's
`--jts-tracking-tight` on `h1`; no utility overrides it.

`ParticipantProfilePage` owns its own `h1` so the title can pair with the
participant avatar, and `CampaignHeader` owns one so the inbox can spend two
rows instead of four. Both wear `jts-title-mark` and match this scale by hand —
if the scale changes, change it in all three.

## Invariants

- Exactly one `JtsPageHeader` per route, and it is that route's only `h1`.
- The component takes strings and nodes only; it never fetches, formats or
  animates. Actions stay usable when they wrap.
- `actions` never contains a back link. The exit is `back`.
- Every admin route opens on `flex flex-col gap-6`, so the space under the
  header is the same on all of them.

## Extension points

Add a slot or prop only after multiple admin routes need the same hierarchy —
not for a single page's one-off. A second heading level is a page concern, not a
header prop.

Reference consumer:
[`OverviewPage.tsx`](../../../apps/admin/src/routes/OverviewPage.tsx); with a
back link,
[`FeedbackResultsPage.tsx`](../../../apps/admin/src/routes/FeedbackResultsPage.tsx).

## Tests

`apps/admin/test/page-chrome.spec.ts` — that the mark is one utility rather than
a class string screens copy, that it counts to six with the accent last, that
every route-owned `h1` wears it, and that the back link and the page gap are the
same everywhere.
