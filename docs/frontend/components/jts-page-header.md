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

Visual scale, marks and spacing follow the [style guide](../../../apps/admin/README.md).
`back` fixes exit placement above the title; see [JtsBackLink](jts-back-link.md).
`ParticipantProfilePage` and `CampaignHeader` own their own `h1` composition.

## Invariants

- A page using this header gets its single `h1` from it.
- Strings and nodes only — never fetches, formats or animates. Actions stay
  usable when they wrap.
- `actions` never contains a back link; exit is `back`.

## Extension points

Add a slot/prop only after multiple routes need the same hierarchy. A second
heading level is a page concern.

Reference: [`OverviewPage.tsx`](../../../apps/admin/src/routes/OverviewPage/OverviewPage.tsx);
with back:
[`FeedbackResultsPage.tsx`](../../../apps/admin/src/routes/FeedbackResultsPage/FeedbackResultsPage.tsx).
