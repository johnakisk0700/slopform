# Cookbook screen (development only)

Status: accepted, verified 2026-08-02 (React 19.2.8, HeroUI `@heroui/react`
3.2.2, Tailwind CSS 4.3.3, Vite 8.1.5, lucide-react 1.25.0,
`@fontsource-variable/manrope` 5.3.0, `@fontsource-variable/commissioner` 5.2.10,
`@fontsource-variable/sora` 5.3.0).

DEV-only audit surface: every visual building block on one page so token/bridge
edits can be judged without touring the product. Instrument, not product —
reports; fetches nothing; changes nothing. Theme/palette axes:
[theming.md](theming.md).

| Route | View | Owns |
| ----- | ---- | ---- |
| `/admin/cookbook` | `CookbookPage` | Gallery + sample content only |

## Development-only gate

Route and nav row both gated on `import.meta.env.DEV` (Vite literal → `false` at
build; Rolldown drops the chunk):

- `App.tsx`: `CookbookPage = DEV ? lazy(() => import(…)) : null`; register
  `<Route path="cookbook">` only when non-null.
- `AdminNavigation.tsx`: `DEV_NAV_ITEMS` from the same gate — empty in
  production (row, icon, label, divider gone). Unnumbered under «Development»;
  product numerals stay product-only.

`apps/admin/test/cookbook.spec.ts` locks both gates and that exactly one dynamic
import of the module exists.

## Sections

Anchors, section `id`s and heading `id`s derive from one `SECTIONS` list.

| # | Section | Shows |
| - | ------- | ----- |
| 01 | Colour tokens | Canvas/surface, borders, ink, brand, copper/link/focus, sidebar, status fg/soft+border/solid |
| 02 | Typography | Manrope + Commissioner (Latin/Greek), weights, tracking, `jts-overline`, tabular figures, `font-mono`. Sora only via BrandLockup in §06 |
| 03 | HeroUI components | Button, Chip, Input, TextArea, Select, Slider, ToggleButton, Popover, Modal, Drawer, Toast, Avatar, ListBox, ScrollShadow, Pagination, Table |
| 04 | Jts components | `JtsPageHeader` specimen, `JtsBackLink`, `JtsStat` tones, `JtsDataTable` + paginator, `JtsLiveIndicator` |
| 05 | Feedback vocabulary | `FeedbackBadges`, `CopyableId`, `ProviderMark`, timestamp pill, confidence bar |
| 06 | Motifs & rules | `BrandLockup`/`BrandMark`, title mark, 3px marker, `.brand-mark`, `.status-dot`, radius/shadow, invariants |

Conventions:

- **Real components** — import specimens (e.g. outbound `FACT_PILL`); do not
  redraw.
- **Static samples** — no fetch; page works with backend down.
- **Two-`h1`:** page has a real `h1`; `JtsPageHeader` specimen sits in
  `aria-hidden` (no focusables / no `actions`) with a caption outside.

## Auditing

1. Edit `tokens.css` / `globals.css` / a palette block.
2. Open `/admin/cookbook`; open popover/modal/drawer for overlay surfaces.
3. Flip Appearance (and Theme) in the operator menu; read again.

No side-by-side dark preview — `dark` on `<html>` is the only dark signal.
Machine AA is in `theme-tokens.spec.ts` / `palettes.spec.ts`; the cookbook is
for judgements tests cannot make.

**New vocabulary lands here in the same change** (token, bridge utility, badge
tone, `Jts*`, first use of a HeroUI primitive). Use literal class strings
(Tailwind scans source text); no colour values of its own.

## Files

| File | Owns |
| ---- | ---- |
| `apps/admin/src/routes/CookbookPage.tsx` | Gallery, frames, sample data |
| `apps/admin/src/App.tsx` | DEV route gate |
| `apps/admin/src/components/admin/AdminNavigation.tsx` | `DEV_NAV_ITEMS` |
| `apps/admin/test/cookbook.spec.ts` | Gates, no-literal-colour, token names, imported specimens |

## References

- [Theming](theming.md), [component inventory](components/README.md)
- [ADR 0005](../decisions/0005-theming-and-dark-mode.md),
  [ADR 0006](../decisions/0006-react-admin-runtime.md)
- Vite env — <https://vite.dev/guide/env-and-mode> (2026-08-01)
