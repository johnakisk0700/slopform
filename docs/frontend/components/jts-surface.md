# JtsSurface

`JtsSurface` is a labelled `section` used by recurring public journey cards. It
always renders an `h2`; heading-free decoration uses local semantic markup
instead of weakening this contract.

Source: [`JtsSurface.vue`](../../../apps/web/app/components/ui/JtsSurface.vue)

| Input/slot               | Contract                               |
| ------------------------ | -------------------------------------- |
| `title`                  | Required heading and accessible name   |
| `eyebrow`, `description` | Optional supporting strings            |
| `tone`                   | Default surface, `blush` or `burgundy` |
| `padding`                | `normal` (default) or `roomy`          |
| default slot             | Body content                           |
| `actions`, `footer`      | Header and footer action seams         |

Burgundy uses strong-surface foreground tokens. Tone never carries status by
itself. Domain metadata, API state and business actions remain with the
consumer. Add a tone or density only when it recurs.

Reference consumers: home, join, registration and feedback.
