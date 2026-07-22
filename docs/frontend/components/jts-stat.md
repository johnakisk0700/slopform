# JtsStat

`JtsStat` renders one summary inside a page-owned, labelled `dl`. It standardises
`dt`/`dd` order and restrained accents; the page owns calculation, formatting
and loading coordination.

Source: [`JtsStat.vue`](../../../apps/web/app/components/ui/JtsStat.vue)

| Input/slot       | Contract                                     |
| ---------------- | -------------------------------------------- |
| `label`, `value` | Required `dt` and primary `dd`               |
| `detail`         | Optional explanatory `dd`                    |
| `tone`           | Default accent, `success` or `warning`       |
| `icon`           | Decorative, hidden from assistive technology |

Value and detail carry meaning; colour and icon do not. Add another status tone
only for a real repeated operational condition. Interactive drill-down remains
a separate link or button.

Reference consumer: admin overview.
