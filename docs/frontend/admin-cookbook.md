# Cookbook screen (development only)

Status: accepted, verified 2026-08-01 (React 19.2.8, HeroUI `@heroui/react`
3.2.2, Tailwind CSS 4.3.3, Vite 8.1.5, lucide-react 1.25.0,
`@fontsource-variable/manrope` 5.3.0).

One page that renders every visual building block the admin panel owns, so a
change to the design tokens or to the HeroUI bridge can be judged in one place.
It ships in development builds only.

## Why it exists

[`theming.md`](theming.md) promises that editing a token in
`packages/design-tokens/src/tokens.css` restyles the whole panel, in both
themes, with no component edits. That promise is only as good as the evidence
for it, and the evidence used to be a tour: open the overview for stats and the
table, the inbox for badges, the outbound queue for the fact pills and the id
buttons, and hope the tour covered whatever the edit touched. Anything not on
the tour — the fifth chip variant, the `info` hairline, the drawer surface —
was audited by nobody.

The cookbook is that tour, on one screen, with nothing missing and nothing
faked. Every swatch is painted by the utility it names, and every HeroUI
specimen is the real component, so an edit to `globals.css` repaints this page
the same way it repaints the product.

It is an instrument, not a product screen. It reports; it changes nothing and
calls nothing.

| Route             | View           | Owns                                             |
| ----------------- | -------------- | ------------------------------------------------ |
| `/admin/cookbook` | `CookbookPage` | The gallery, its sample content and nothing else |

## Development only, and why production never ships it

Both the route and the navigation row are gated on `import.meta.env.DEV`.

- `apps/admin/src/App.tsx` binds the lazy component to the gate:
  `const CookbookPage = import.meta.env.DEV ? lazy(() => import(…)) : null`,
  and registers `<Route path="cookbook">` only when that produced a component.
  React Router's `createRoutesFromChildren` ignores non-elements, so the
  production arm collapses to nothing rather than to a broken route.
- `apps/admin/src/components/admin/AdminNavigation.tsx` builds `DEV_NAV_ITEMS`
  from the same gate; in production it is an empty array and the row, its icon,
  its label and the divider above it all disappear with it.

`import.meta.env.DEV` is a **literal Vite replaces with `false`** when it
builds. Both branches constant-fold, the only `import("./routes/CookbookPage")`
in the tree becomes unreachable, and Rolldown drops the module: no route, no nav
row, no chunk, no bytes. This is the mechanism, not a convention — a runtime
flag would leave the chunk in the bundle for anyone who guessed the URL.

`apps/admin/test/cookbook.spec.ts` locks both gates, including that exactly one
dynamic import of the module exists.

The row sits below the numbered product areas under a «Development» label,
unnumbered: the numerals index the areas of the product, and an instrument for
reading design tokens is not one of them.

## What is on it

Six sections, in reading order, each with its own lucide glyph. A plain
(non-sticky) list of anchors at the top navigates them; the anchor, the section
`id` and the heading `id` are all derived from one `SECTIONS` list, so a rename
cannot leave the contents pointing at nothing.

| #   | Section             | Shows                                                                                                                                                                                               |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | Colour tokens       | Canvas/surface, borders, ink (as text), brand wine, copper/link/focus/selection, the sidebar family, and each of the four status tones as its fg / soft+border / solid triple                       |
| 02  | Typography          | The `--jts-text-*` scale with Latin and Greek samples, the five weights, tracking, `jts-overline`, tabular vs proportional figures, `font-mono` machine strings                                     |
| 03  | HeroUI components   | Button (every variant, size, disabled, icon-only), Chip, Input (+ invalid), TextArea, Select, Slider, ToggleButton, Popover, Modal, Drawer, Toast, Avatar, ListBox, ScrollShadow, Pagination, Table |
| 04  | Jts components      | `JtsPageHeader` (as a specimen), `JtsStat` in all three tones, `JtsDataTable` with the paginator, `JtsLiveIndicator` with a toggle to spin it                                                       |
| 05  | Feedback vocabulary | `FeedbackBadges` — six tones, soft and strong, both sizes, with and without glyphs — plus `CopyableId`, `ProviderMark` beside model pills, the timestamp pill and the confidence bar                |
| 06  | Motifs & rules      | The 3px marker horizontal and vertical, `.brand-mark`, `.status-dot`, the radius and shadow scales, and the invariants written out                                                                  |

Two conventions the page holds itself to:

- **The specimens are the real components.** The outbound pane's `FACT_PILL`,
  `TimestampPill` and `ConfidenceValue` were module-private; the cookbook is
  their second consumer and imports them rather than redrawing them. A cookbook
  that drifts from the component it documents is worse than none.
- **Nothing is fetched.** All sample content is static, invented and in the
  product's own voice (Greek names, real-sounding dinners). The page renders
  with the backend down, because the moment somebody wants to check a token is
  not the moment to need a database.

### The two-`h1` question

`JtsPageHeader` renders the page's `h1`, and the page already has a real one at
the top. Its specimen is therefore the unmodified component inside an
`aria-hidden="true"` frame, with a visible caption outside the frame explaining
what it is. The frame holds no focusable control — the specimen omits the
`actions` slot — so hiding it takes nothing away from anyone. Faking a lower
heading level would have made the one specimen on the page that is not the real
component.

## Auditing a theme change

1. Make the change — a value in `tokens.css`, a mapping in `globals.css`.
2. Open `/admin/cookbook` and read it top to bottom. Open the popover, the
   modal and the drawer: overlay surfaces, the backdrop and `--overlay-shadow`
   are only visible while something is open.
3. Flip **Appearance** in the operator menu (sidebar footer, or the top bar on
   small screens) to Dark and read it again.

There is deliberately **no side-by-side dark preview**. The `dark` class on
`<html>` is the only theme signal in the system; a second theme rendered inside
one document would be the one thing on the page that cannot be trusted.

Contrast is verified separately and by machine —
`apps/admin/test/theme-tokens.spec.ts` resolves the real tokens and asserts AA
for the critical pairs in both themes. The cookbook is for the judgements a
test cannot make: whether the tones still belong to each other.

## Palettes

The panel's six themes (Join The Six, Graphite, Noir, Amphora, Linen,
Iris — see [theming.md](theming.md)) are switched from the operator menu's
**Theme** group, and the cookbook is where a palette is audited: every
specimen on the page repaints with the selection, in both dark and light. The
cookbook briefly carried its own dev-only palette switcher while the
candidates were auditioned; the shipped Theme picker replaced it, and
`apps/admin/test/palettes.spec.ts` now holds every shipped theme to the same
AA floor the audition enforced, and to owning a brand colour of its own.

## The rule for new vocabulary

**New visual vocabulary is added to the cookbook in the same change that
introduces it.** A new `Jts*` component, a new badge tone, a new semantic token,
a new bridge utility, a HeroUI primitive used for the first time — all of them
land here alongside their real use. A gallery that is only mostly complete
sends the reader back to the tour it replaced.

Adding to it is deliberately cheap: the section frames (`Section`, `Specimen`)
are local to the file, the specimen data are plain arrays, and the only hard
rule is the house one — semantic utilities, literal class strings (Tailwind
scans source text, so a class assembled by interpolation emits no rule and the
specimen would quietly lie), and no colour value of its own.

## Files

| File                                                  | Owns                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/routes/CookbookPage.tsx`              | The gallery, its frames and its sample data                                                                     |
| `apps/admin/src/App.tsx`                              | The `import.meta.env.DEV` route gate                                                                            |
| `apps/admin/src/components/admin/AdminNavigation.tsx` | `DEV_NAV_ITEMS` and the unnumbered development group                                                            |
| `apps/admin/test/cookbook.spec.ts`                    | Both gates, the no-literal-colour rule, the token names, and that the specimens are imported rather than copied |

## References

- [Theming, design tokens and dark mode](theming.md)
- [Frontend component inventory](components/README.md)
- [ADR 0005](../decisions/0005-theming-and-dark-mode.md),
  [ADR 0006](../decisions/0006-react-admin-runtime.md)
- Vite env variables and modes (`import.meta.env.DEV`) —
  <https://vite.dev/guide/env-and-mode> (2026-08-01)
