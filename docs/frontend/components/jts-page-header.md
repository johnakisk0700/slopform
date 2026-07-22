# JtsPageHeader

`JtsPageHeader` renders the single admin-route `h1`, optional
eyebrow/description and route-owned actions. It owns responsive hierarchy, not
metadata, breadcrumbs, fetching or animation.

Source: [`JtsPageHeader.vue`](../../../apps/web/app/components/ui/JtsPageHeader.vue)

| Input/slot               | Contract                    |
| ------------------------ | --------------------------- |
| `title`                  | Required visible `h1`       |
| `eyebrow`, `description` | Optional supporting strings |
| `actions`                | Route-owned controls/links  |

Each route has exactly one page header. Actions remain usable when wrapped;
add another slot only after multiple admin routes require the same hierarchy.

Reference consumer: admin operations overview.
