# JtsPageHeader

`JtsPageHeader` renders one admin route's single `h1` with the signature
horizontal marker, an optional wine eyebrow, a muted description and a
route-owned actions row. It owns the responsive title hierarchy — not metadata,
breadcrumbs, fetching or the page entrance animation (that lives in
`AdminShell`'s main region).

Source: [`JtsPageHeader.tsx`](../../../apps/admin/src/components/ui/JtsPageHeader.tsx)

## Contract

| Prop          | Type         | Contract                                                             |
| ------------- | ------------ | -------------------------------------------------------------------- |
| `title`       | `string`     | Required. The page's only `h1`; carries the 3px wine marker beneath. |
| `eyebrow`     | `string?`    | Tracked wine micro-caps kicker rendered above the title.             |
| `description` | `string?`    | Muted supporting sentence under the title (max ~65ch).               |
| `actions`     | `ReactNode?` | Route-owned controls/links in a wrapping row below the copy.         |

The marker is a `::after` pseudo-element on the `h1` (3px tall, 2.75rem wide,
`bg-primary`) — motif 1 from the design contract, meaning "this matters", never
"you are here".

## Invariants

- Exactly one `JtsPageHeader` per route, and it is that route's only `h1`.
- The component takes strings and nodes only; it never fetches, formats or
  animates. Actions stay usable when they wrap.

## Extension points

Add a slot or prop only after multiple admin routes need the same hierarchy —
not for a single page's one-off. A second heading level is a page concern, not a
header prop.

Reference consumer:
[`OverviewPage.tsx`](../../../apps/admin/src/routes/OverviewPage.tsx).
