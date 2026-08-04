# JtsStat

`JtsStat` renders one operational metric as a bordered card **inside a
page-owned, labelled `dl`**. It emits a card `div` wrapping a `dt` label, a big
`dd` value and an optional `dd` detail, with margins reset so the definition list
does not indent them. The page owns calculation, formatting and loading
coordination; the card standardises `dt`/`dd` order, the 3px marker and the
restrained tone accents.

Below the `sm` breakpoint the card reduces its padding, label size, value size
and icon inset so a page can place two metrics side by side without clipping.
Its established desktop density resumes at `sm`.

Source: [`JtsStat.tsx`](../../../apps/admin/src/components/ui/JtsStat.tsx)

## Contract

| Prop     | Type                      | Contract                                                              |
| -------- | ------------------------- | --------------------------------------------------------------------- |
| `label`  | `string`                  | Required. The micro-caps `dt`.                                        |
| `value`  | `string \| number`        | Required. The big tabular `dd` figure.                                |
| `detail` | `string?`                 | Optional explanatory `dd` beneath the value.                          |
| `tone`   | `"success" \| "warning"?` | Toned left marker, value and glyph; neutral wine marker when omitted. |
| `icon`   | `LucideIcon?`             | Decorative glyph pinned top-right, `aria-hidden`.                     |

`tone` selects the vertical 3px `border-l` marker (motif 1): wine by default,
`border-l-success` / `border-l-warning` when toned, matched by the value and icon
colour. A neutral card's icon uses `text-ink-subtle`.

## Invariants

- Meaning lives in `label`, `value` and `detail`. Colour and icon are redundant
  accents only — never the sole carrier of a state (design contract a11y rule).
- The card must sit inside a page's labelled `dl`; it does not render its own
  list wrapper.
- `value` is presentation-ready — the page formats numbers (tabular figures are
  applied by the card).

## Extension points

Add a new `tone` only for a real, repeated operational condition, paired with a
status token — not for one-off emphasis. Interactive drill-down stays a separate
link or button beside the stat, never folded into the card.

Reference consumer:
[`OverviewPage.tsx`](../../../apps/admin/src/routes/OverviewPage.tsx) — a
four-column `dl` labelled "Operations summary".
