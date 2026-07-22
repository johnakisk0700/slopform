# ADR 0005: Design tokens and class-based light/dark theming

- Status: Accepted
- Date: 2026-07-22

## Decision

The admin panel is themed through one token system with a single dark-mode
signal, and PrimeVue is a consumer of that system rather than a parallel one.

- `packages/design-tokens/src/tokens.css` is the single source of truth for
  every colour, type, space, radius, shadow and motion value. Screens and
  components consume **semantic** tokens (`--jts-color-surface`,
  `--jts-color-text-muted`, …), never raw primitives or ad-hoc colours.
- Dark mode is driven by one signal: the `jts-dark` class on `<html>`.
  `tokens.css` defines light under `:root` and the dark overrides under
  `:root.jts-dark`. PrimeVue's `darkModeSelector` is set to `.jts-dark`, so the
  framework flips off the same class.
- The PrimeVue preset (`app/theme/jts-preset.ts`) defines no palette of its own.
  It maps PrimeVue's semantic slots onto the `--jts-*` variables with `var()`,
  so PrimeVue components match hand-written CSS and flip automatically. PrimeVue
  styles live in the `primevue` cascade layer (`cssLayer`) so unlayered app CSS
  overrides them without specificity fights.
- Appearance preference (light / dark / system) is owned by `useTheme()`,
  persisted to `localStorage` under `jts-theme`, applied before first paint by
  an inline head script to avoid a flash, and kept in step with the OS while in
  system mode. The control lives in the top-right user menu (`AdminUserMenu`).
- The typeface is **Manrope** (variable, self-hosted via Fontsource), the single
  family for display, UI and body. It carries Latin **and Greek** in one family
  because operators work in Greek; numbers use tabular figures.

## Why

- One token source consumed by both PrimeVue and our CSS means extending a
  screen never requires plumbing colours by hand: use a semantic token (or a
  plain PrimeVue component) and both themes are correct.
- A single class as the dark signal keeps the token layer, PrimeVue and the
  pre-paint script in agreement; there is nothing else to synchronise.
- Manrope replaces DM Sans and Newsreader because those lack Greek; Fraunces,
  Nunito, Rubik and Figtree were rejected for the same reason. A single
  Greek-capable family keeps Greek and English visually identical for the
  operator.
- The previous shell leaned on decorative radial-gradient glows and a floating
  pseudo-element circle. Those are removed in favour of flat, hairline,
  editorial surfaces; personality comes from type and a warm red palette.

## Consequences

- New colours are added as tokens (primitive + semantic), not as literals in
  components. `packages/design-tokens` verifies the core token names and
  `apps/web/test/theme-tokens.spec.ts` verifies AA contrast in both themes.
- The display face is the same sans at a heavier weight; there is no serif
  dependency.
- The dark palette is a warm wine-black. Both themes are first-class and must be
  kept above AA contrast whenever tokens change.
- `cssLayer` is enabled; app CSS is written unlayered and always wins over
  PrimeVue.

## References

- [`docs/frontend/theming.md`](../frontend/theming.md) — token reference, the
  dark-mode mechanism and the extension guide.
- PrimeVue 4 styled theming, verified 2026-07-22:
  <https://primevue.dev/theming/styled/>.
