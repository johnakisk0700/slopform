# JtsPageHeader

One admin route's single `h1`, optional back link, muted description and
route-owned actions. Owns responsive title
hierarchy and part order — not metadata, breadcrumbs, fetching or the page
entrance (`AdminShell`).

Source: [`JtsPageHeader.tsx`](../../../apps/admin/src/components/ui/JtsPageHeader.tsx)

## Contract

| Prop          | Type                             | Contract                                                              |
| ------------- | -------------------------------- | --------------------------------------------------------------------- |
| `title`       | `string`                         | Required. The page's only `h1`, in bold Manrope.                      |
| `back`        | `{ to: string; label: string }?` | `JtsBackLink` above the title. Detail screens only.                   |
| `description` | `string?`                        | Muted supporting sentence under the title (max ~65ch).                |
| `actions`     | `ReactNode?`                     | Route-owned controls/links bottom-right of the full-width header row. |

Visual scale and spacing follow the [style guide](../../../apps/admin/README.md).
The shared `jts-page-title` recipe reserves space to the left for a decorative
Lucide `Hash` with `aria-hidden="true"` and `jts-page-title-mark`. The 16px icon
sits beside the first line, inside the heading's box so narrow layouts and
truncated campaign titles keep it visible. It carries no status meaning or
accessible text, and has no animation. At desktop widths, `lg:-ms-6` lets the
mark hang in the page gutter while title text stays aligned with the description.
Narrow layouts and profile cards keep the mark within their content area.
There is no underline or reserved space below the title for decoration.
`back` fixes exit placement above the title; see [JtsBackLink](jts-back-link.md).
`ParticipantProfilePage` and `CampaignHeader` own their own `h1` composition
and use the same title recipe.

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
