# JtsStat

## Purpose and boundary

`JtsStat` renders one compact operational summary inside a page-owned
definition list. It standardises label/value/detail order and restrained status
accents. The caller owns metric calculation, locale formatting, loading
coordination and whether the number is fit to show.

Source: [`apps/web/app/components/ui/JtsStat.vue`](../../../apps/web/app/components/ui/JtsStat.vue).

## Contract

| Input/slot    | Type                                       | Behavior                                                          |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `label`       | `string`, required                         | Renders a `dt`                                                    |
| `value`       | `string \| number`, required               | Renders the primary `dd`                                          |
| `detail`      | `string \| null`                           | Optional explanatory `dd`                                         |
| `tone`        | `primary \| neutral \| success \| warning` | Changes the decorative accent; defaults to `neutral`              |
| `icon`        | decorative slot                            | Caller supplies an icon which is hidden from assistive technology |
| `detail` slot | content                                    | Replaces the detail prop for richer, still concise context        |

## Invariants

- Consumers place one or more stats directly inside a labelled `dl`.
- The value and detail carry the meaning; icon and tone are never the only
  status signal.
- Preview metrics remain explicitly labelled as preview data.
- Domain formatting stays with the page or feature.

## Extension points

Add a `danger` tone only when a real operational condition needs it. Interactive
drill-down behavior belongs in a separate link or button rather than making the
whole metric card a mystery control.

## Operations and tests

The admin overview is the reference consumer. Strict Vue typecheck verifies the
slot and prop contract; run lint and production build after markup changes.

## Decisions and references

- Definition list semantics: <https://html.spec.whatwg.org/multipage/grouping-content.html#the-dl-element>
- Reuse hierarchy: [`README.md`](README.md)
