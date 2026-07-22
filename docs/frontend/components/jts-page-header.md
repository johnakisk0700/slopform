# JtsPageHeader

`JtsPageHeader` renders the single route `h1`, optional eyebrow/description,
actions and an optional contextual aside. It owns responsive hierarchy, not
metadata, breadcrumbs, fetching or animation.

Source: [`JtsPageHeader.vue`](../../../apps/web/app/components/ui/JtsPageHeader.vue)

| Input/slot               | Contract                                                             |
| ------------------------ | -------------------------------------------------------------------- |
| `title`                  | Required visible `h1`                                                |
| `eyebrow`, `description` | Optional supporting strings                                          |
| `variant`                | `public` (default), `admin` or `policy` visual hierarchy             |
| `actions`                | Route-owned controls/links                                           |
| `aside`                  | Context or decoration; meaningful content supplies its own semantics |

Each route has exactly one page header. Actions remain usable when wrapped;
decorative aside content is `aria-hidden`. Add a variant only after multiple
routes require a materially different hierarchy.

Reference consumers: home, join, registration, feedback, legal and admin.
