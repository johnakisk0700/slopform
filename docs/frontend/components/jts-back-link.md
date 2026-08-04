# JtsBackLink

The admin panel's one way out of a detail screen: left chevron, wine,
`Back to <place>`. Owns glyph, tone and hover — not placement
(`JtsPageHeader`'s `back` prop) and not the label wording (the route's).

Source: [`JtsBackLink.tsx`](../../../apps/admin/src/components/ui/JtsBackLink.tsx)

## Contract

| Prop | Type | Contract |
| ---- | ---- | -------- |
| `to` | `string` | Required. Destination route. |
| `children` | `ReactNode` | Required. Label: `Back to <place>`, destination's wording. |

## Invariants

- One glyph: `ChevronLeft` (not `ArrowLeft`).
- One grammar: `Back to <place>` — chevron for direction, words for destination;
  screen reader gets a full sentence.
- Never a page action. Renders above the title; `actions` must not contain one.
- Only motion: chevron +2px on hover (collapsed by `prefers-reduced-motion`).

## Placement

Prefer `JtsPageHeader`'s `back` prop. Render directly only without a page header:
not-found branches, or `CampaignHeader` (shares the link's line with campaign
actions).

## Tests

`apps/admin/test/page-chrome.spec.ts` — no second back-link dialect in routes,
labels match `Back to <place>`, header places it above eyebrow/title/actions.
