# JtsSurface

## Purpose and boundary

`JtsSurface` is a labelled content region with a consistent heading, tone,
density, action seam and optional footer. It exists because this structure
recurs across public journey cards; it is not a generic replacement for every
`div` with a border.

Source: [`apps/web/app/components/ui/JtsSurface.vue`](../../../apps/web/app/components/ui/JtsSurface.vue).

## Contract

| Input/slot                | Type                                    | Behavior                                                         |
| ------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `title`                   | `string`, required                      | Generates the visible heading and `aria-labelledby` relationship |
| `description` / `eyebrow` | `string \| null`                        | Optional contextual copy                                         |
| `as`                      | `section \| article \| aside \| div`    | Chooses the correct host semantic; defaults to `section`         |
| `headingTag`              | `h2 \| h3`                              | Preserves the consuming page's heading hierarchy                 |
| `tone`                    | `default \| cream \| blush \| burgundy` | Semantic visual treatment with maintained text contrast          |
| `padding`                 | `none \| compact \| normal \| roomy`    | Controls established density only                                |
| default slot              | content                                 | Surface body                                                     |
| `actions`                 | controls/links                          | Header-level actions                                             |
| `footer`                  | content/actions                         | Separated footer seam                                            |

## Invariants

- `title` is required. Heading-free decoration uses semantic HTML and a local
  class instead of weakening this contract.
- Burgundy surfaces use the strong-surface foreground tokens; callers do not
  set ad hoc white text.
- `as="div"` is only valid when the surrounding landmark already supplies the
  appropriate structural boundary.
- Tone is never used as the only status signal.

## Extension points

Add a tone or density only when it recurs. Domain-specific metadata, API state
and business actions stay in the consuming feature.

## Operations and tests

Public home, join, registration and feedback routes are reference consumers.
Verify contrast in both system color schemes and run frontend lint, strict
typecheck and build after contract changes.

## Decisions and references

- Project design tokens:
  [`packages/design-tokens/src/tokens.css`](../../../packages/design-tokens/src/tokens.css)
- Reuse hierarchy: [`README.md`](README.md)
