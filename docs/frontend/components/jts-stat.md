# JtsStat

One operational metric as a bordered card **inside a page-owned, labelled
`dl`**. Emits `dt` label, big `dd` value, optional `dd` detail; resets margins
so the list does not indent them. Page owns calculation, formatting and loading;
card owns `dt`/`dd` order, 3px marker and tone accents.

Below `sm`: tighter padding/label/value/icon so two metrics sit side by side;
desktop density resumes at `sm`.

Source: [`JtsStat.tsx`](../../../apps/admin/src/components/ui/JtsStat.tsx)

## Contract

| Prop     | Type                      | Contract                                                      |
| -------- | ------------------------- | ------------------------------------------------------------- |
| `label`  | `string`                  | Required. Micro-caps `dt`.                                    |
| `value`  | `string \| number`        | Required. Big tabular `dd` figure.                            |
| `detail` | `string?`                 | Optional explanatory `dd` beneath the value.                  |
| `tone`   | `"success" \| "warning"?` | Toned left marker, value and glyph; wine marker when omitted. |
| `icon`   | `LucideIcon?`             | Decorative top-right glyph, `aria-hidden`.                    |

`tone` selects the vertical 3px `border-l` marker: wine default,
`border-l-success` / `border-l-warning` when toned (value + icon match). Neutral
icon: `text-ink-subtle`.

## Invariants

- Meaning in `label` / `value` / `detail`; colour and icon are redundant only.
- Must sit inside a page's labelled `dl` — no list wrapper of its own.
- `value` is presentation-ready; card applies tabular figures.

## Extension points

New `tone` only for a repeated operational condition paired with a status token.
Drill-down stays a separate control beside the card.

Reference: [`OverviewPage.tsx`](../../../apps/admin/src/routes/OverviewPage.tsx).
