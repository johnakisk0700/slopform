# JtsBackLink

`JtsBackLink` is the admin panel's one way out of a detail screen: a left
chevron, wine, and the destination named as `Back to <place>`. It owns the
glyph, the tone and the hover behaviour — not where it sits (that is
`JtsPageHeader`'s `back` prop) and not what it says (that is the route's).

Source: [`JtsBackLink.tsx`](../../../apps/admin/src/components/ui/JtsBackLink.tsx)

## Contract

| Prop       | Type         | Contract                                                        |
| ---------- | ------------ | --------------------------------------------------------------- |
| `to`       | `string`     | Required. The route this returns to.                            |
| `children` | `ReactNode?` | The label. `Back to <place>`, in the destination's own wording. |

## Why it exists

Four detail screens had grown four of these. The event screen and the
participant profile used a `ChevronLeft` and «Back to …»; the outbound queue used
an `ArrowLeft`, wrapped the link in a `<p>` and underlined it on hover; the
results screen had no glyph at all and filed the link under `JtsPageHeader`'s
`actions`, among the buttons that act on the page. Every one of them worked. The
cost was that the operator relearned the exit on each route, and that a back
link had quietly become a page action.

## Invariants

- One glyph: `ChevronLeft`. An arrow is not a second dialect of the same idea.
- One grammar: `Back to <place>`. The chevron carries the direction, the words
  carry the destination, and a screen reader gets a whole sentence rather than a
  bare noun.
- It is never a page action. Actions change the thing on screen; this leaves it.
  It renders above the title, and `actions` may not contain one.
- The only motion is the chevron sliding 2px on hover, which the base layer's
  `prefers-reduced-motion` rule collapses.

## Placement

Prefer `JtsPageHeader`'s `back` prop — it puts the link above the eyebrow, so
ordering is decided once for the whole panel. Render `JtsBackLink` directly only
where there is no page header to put it in: a not-found branch, or
`CampaignHeader`, whose two-row layout deliberately shares the link's line with
the campaign's actions to save the inbox ~230px of chrome.

## Tests

`apps/admin/test/page-chrome.spec.ts` — that no route builds a second back link
(no bare `ChevronLeft` or `ArrowLeft` in a route), that every label reads
`Back to <place>`, and that the header renders it above the eyebrow, the title
and the actions row.
