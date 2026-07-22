# JtsPageHeader

## Purpose and boundary

`JtsPageHeader` owns the title hierarchy and responsive relationship between
page copy, actions and optional decorative/contextual aside content. It does not
own breadcrumbs, route metadata, data fetching or page-specific actions.

Source: [`apps/web/app/components/ui/JtsPageHeader.vue`](../../../apps/web/app/components/ui/JtsPageHeader.vue).

## Contract

| Input/slot    | Type                        | Behavior                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------- |
| `title`       | `string`, required          | Renders the visible heading                                                     |
| `eyebrow`     | `string \| null`            | Optional short context above the heading                                        |
| `description` | `string \| null`            | Optional supporting copy below the heading                                      |
| `variant`     | `public \| admin \| policy` | Selects the established visual hierarchy; defaults to `public`                  |
| `align`       | `start \| center`           | Aligns the copy block; defaults to `start`                                      |
| `headingTag`  | `h1 \| h2`                  | Defaults to `h1`; `h2` is only for a header nested below an existing page title |
| default slot  | content                     | Optional content following the description                                      |
| `actions`     | controls/links              | Wraps and stacks actions at narrow widths                                       |
| `aside`       | content                     | Optional contextual or decorative content; source order keeps copy first        |

## Invariants

- Every route still has one page-level `h1`; changing `headingTag` must not
  create a skipped or duplicate page heading.
- Actions remain usable when they wrap or become full-width on small screens.
- Aside decoration is `aria-hidden`; meaningful aside content supplies its own
  semantics.
- The component owns no animation.

## Extension points

Add a variant only when several routes need a materially different hierarchy.
Page-specific banners and data belong beside or below the header, not inside a
new prop collection.

## Operations and tests

The home, join, registration, feedback, legal and admin overview routes are the
reference consumers. Run frontend lint, strict typecheck and production build
after changing its contract.

## Decisions and references

- Vue 3.5 typed slots and props, verified 2026-07-22:
  <https://vuejs.org/guide/typescript/composition-api>
- Reuse hierarchy: [`README.md`](README.md)
