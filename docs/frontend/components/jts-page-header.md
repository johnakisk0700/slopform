# JtsPageHeader

One admin route's single `h1` with the six-dot title mark, optional back link,
wine eyebrow, muted description and route-owned actions. Owns responsive title
hierarchy and part order — not metadata, breadcrumbs, fetching or the page
entrance (`AdminShell`).

Source: [`JtsPageHeader.tsx`](../../../apps/admin/src/components/ui/JtsPageHeader.tsx)

## Contract

| Prop          | Type                             | Contract                                                              |
| ------------- | -------------------------------- | --------------------------------------------------------------------- |
| `title`       | `string`                         | Required. The page's only `h1`; carries the six-dot mark beneath.     |
| `back`        | `{ to: string; label: string }?` | `JtsBackLink` above the eyebrow. Detail screens only.                 |
| `eyebrow`     | `string?`                        | Tracked wine micro-caps kicker above the title.                       |
| `description` | `string?`                        | Muted supporting sentence under the title (max ~65ch).                |
| `actions`     | `ReactNode?`                     | Route-owned controls/links bottom-right of the full-width header row. |

Mark = `jts-title-mark` in `globals.css`: six 3px dots, five
`--jts-color-primary` + sixth `--jts-color-accent`. Static; means "page title".
`back` is a prop so exit placement is decided once — see
[`jts-back-link.md`](jts-back-link.md).

## Scale

Fixed `1.375rem` display title, `text-sm` description, `jts-overline` eyebrow —
not a viewport clamp. Letter-spacing from base `--jts-tracking-tight` on `h1`.
`ParticipantProfilePage` and `CampaignHeader` own their own `h1` (avatar pairing
/ two-row inbox chrome) but wear `jts-title-mark` and match this scale by hand.

## Invariants

- Exactly one `JtsPageHeader` per route; it is that route's only `h1`.
- Strings and nodes only — never fetches, formats or animates. Actions stay
  usable when they wrap.
- `actions` never contains a back link; exit is `back`.
- Every admin route opens on `flex flex-col gap-6` (space under header shared).

## Extension points

Add a slot/prop only after multiple routes need the same hierarchy. A second
heading level is a page concern.

Reference: [`OverviewPage.tsx`](../../../apps/admin/src/routes/OverviewPage.tsx);
with back:
[`FeedbackResultsPage.tsx`](../../../apps/admin/src/routes/FeedbackResultsPage.tsx).

## Tests

`apps/admin/test/page-chrome.spec.ts` — mark utility, six dots with accent last,
every route `h1` wears it, back link + page gap consistent.
