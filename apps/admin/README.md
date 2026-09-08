# Slopform admin style guide

Status: current admin UI contract, verified 2026-09-08.

This is the short guide for building a screen in `apps/admin`. It describes the
tokens and conventions that are actually shipped. The values live in the
design-token package; this file explains which role to choose.

## Where styles come from

There are three layers:

| Layer    | File                                      | Responsibility                                                                                                       |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tokens   | `packages/design-tokens/src/tokens.css`   | Primitive colours, semantic colours, type, spacing, shape, elevation and motion. The default Slopform theme is here. |
| Palettes | `packages/design-tokens/src/palettes.css` | Semantic colour overrides for the five selectable palettes. Type, spacing, shape and motion stay shared.             |
| Bridge   | `apps/admin/src/styles/globals.css`       | Maps the `--jts-*` tokens to HeroUI and Tailwind names. It does not own a colour value.                              |

Use semantic tokens through the bridge. A component should not reference a
primitive (`--jts-wine-700`) or a raw hex/rgb/oklch value.

## Colour roles

The default house palette is wine on warm paper. A palette changes the resolved
semantic values while keeping these roles stable.

| Role             | Token                                                                                       | Tailwind utilities                                                       | Use                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas           | `--jts-color-canvas`                                                                        | `bg-canvas`                                                              | Page background.                                                                                                                                                                               |
| Surface          | `--jts-color-surface`                                                                       | `bg-surface`                                                             | Cards, panels and ordinary content surfaces.                                                                                                                                                   |
| Raised / sunken  | `--jts-color-surface-raised`, `--jts-color-surface-sunken`                                  | `bg-surface-raised`, `bg-surface-sunken`                                 | Inputs, overlays, inset blocks and table stripes.                                                                                                                                              |
| Text             | `--jts-color-text`, `--jts-color-text-muted`, `--jts-color-text-subtle`                     | `text-ink`, `text-ink-muted`, `text-ink-subtle`                          | Body, secondary and tertiary copy.                                                                                                                                                             |
| Border           | `--jts-color-border-subtle`, `--jts-color-border`, `--jts-color-border-strong`              | `border-border-subtle`, `border-border`, `border-border-strong`          | Dividers, cards and field edges.                                                                                                                                                               |
| Primary          | `--jts-color-primary` and its `-hover`, `-active`, `-soft`, `-contrast`, `-border` variants | `text-primary`, `bg-primary`, `bg-primary-soft`, `border-primary-border` | Main action, brand emphasis and links. HeroUI `Button variant="primary"` uses this role.                                                                                                       |
| Secondary action | No separate `--jts-color-secondary` token                                                   | HeroUI `variant="secondary"`                                             | A lower emphasis action. HeroUI maps it to the default surface (`--jts-color-surface-sunken`) with the normal ink text colour. Use the component variant; do not invent a second brand colour. |
| Accent           | `--jts-color-accent`, `--jts-color-accent-soft`                                             | `text-copper`, `bg-copper-soft`                                          | Warm secondary emphasis, small markers and occasional labels. It is not the default button colour.                                                                                             |
| Status           | `--jts-color-success`, `-warning`, `-danger`, `-info` and each `-soft` / `-border`          | `text-success`, `bg-warning-soft`, `border-danger-border`, etc.          | State and attention. Always pair the tone with visible text or an icon.                                                                                                                        |
| Sidebar          | `--jts-color-sidebar-*`                                                                     | `bg-sidebar`, `text-sidebar-fg`, `text-sidebar-active-index`, etc.       | The inverse navigation slab and its states.                                                                                                                                                    |

`--jts-color-link` and `--jts-color-focus` are semantic roles too. Use the
existing link and focus behaviour instead of styling anchors or focus rings
with a palette value. `rose` is a decorative tea tint, not a status tone.

Light/dark is one axis: the `dark` class on `<html>`. Palette is the other:
`data-palette` on `<html>`; no component should branch on either axis for a
colour that the tokens already resolve.

The available palettes are Slopform (the default house wine, represented by no
`data-palette` attribute), Graphite, Noir, Amphora, Linen and Iris. The
pre-paint script and `usePalette` keep the `jts-palette` choice in sync. A
palette repaints semantic colours only; type, spacing, shape and motion remain
shared. Token checks cover the light/dark contrast pairs and keep status tones
visibly distinct.

## Spacing and layout rhythm

The base unit is `0.25rem` (4px). The shared scale is:

| Token                              | Value                  | Typical Tailwind class           |
| ---------------------------------- | ---------------------- | -------------------------------- |
| `space-1` through `space-6`        | 4, 8, 12, 16, 20, 24px | `gap-1` … `gap-6`, `p-4`, `px-3` |
| `space-8`, `space-10`, `space-12`  | 32, 40, 48px           | `gap-8`, `p-10`, `py-12`         |
| `space-16`, `space-20`, `space-24` | 64, 80, 96px           | large section separation         |

Use the scale for padding, gaps and margins. `gap-2` (8px), `gap-3` (12px)
and `gap-4` (16px) are the normal compact, grouped and card-level rhythms.
Use `gap-6` or larger when a new section needs air. Arbitrary values are for
measured geometry (a chart, a viewport constraint or a fluid type formula),
not for choosing a new spacing rhythm.

The UI also uses 2px half-steps such as `gap-1.5` and `px-2.5` for compact
controls and icon alignment. They are deliberate members of the existing
rhythm; use them when matching a documented control or component geometry.

The content container is `max-w-content` (`--jts-content-width: 96rem`). Keep
grid tracks shrinkable with `min-w-0` when a pane sits beside another pane.

## Type

| Role             | Token / utility                                               | Use                                                           |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| UI and body      | `--jts-font-sans` / `font-sans` (Manrope Variable)            | All normal copy, controls and data. Supports Latin and Greek. |
| Display headings | `--jts-font-display` / `font-display` (Commissioner Variable) | Page titles and display-level headings.                       |
| Wordmark         | `--jts-font-brand` / `font-brand` (Sora Variable)             | `BrandLockup` only. Never use it for UI copy.                 |
| Machine strings  | `--jts-font-mono` / `font-mono`                               | IDs, model names and machine timestamps; never prose.         |

The semantic type scale is `2xs` (10px), `xs` (12px), `sm` (14px), `md`
(16px), then fluid `lg`, `xl`, `2xl` and `3xl`. The scale is available as
`--jts-text-*`; use `text-[length:var(--jts-text-lg)]` for a semantic fluid
size because Tailwind's `text-lg` is its own fixed scale. Body leading is 1.6;
headings use tight or snug leading. Use `tabular-nums` for numbers operators
compare.

Metadata uses the shared `jts-overline` recipe: uppercase, extrabold and
tracked. Keep ordinary content sentence case. Page titles may use the shared
`jts-title-mark`; `JtsPageHeader` uses a fixed `1.375rem` display title for the
shared page header. The sidebar index is the navigation indicator.

## Shape, elevation and motion

The shared radii are `xs` (4px), `sm` (6.4px), `md` (9.6px), `lg` (13.6px),
`xl` (17.6px), `pill` and `circle`. Use HeroUI primitives for interactive
shape and motion. Shadows are `xs`, `sm`, `md` and `lg`; surfaces stay flat and
shadows belong to floating overlays. Shared motion durations are 120ms, 200ms
and 320ms with the token easing curves. The app's page entrance is 200ms and
must respect reduced motion.

## Components and accessibility

Use HeroUI for buttons, menus, dialogs, drawers, selects, tabs, tables, toasts
and other interactive behaviour. Reuse a documented `Jts*` component before
creating another one. Routes own data fetching and page-specific layout;
shared UI does not hide domain rules.

Each page has one `h1`, a visible focus path and status text alongside status
colour. Icon-only controls have an accessible label. Use the existing skip
link, `#main-content` landmark and `usePageMeta` conventions. Do not add a
`dark:` colour branch, a gradient, a glow or a new emphasis motif when a token
or shared component already covers the case.

## Implementation and checks

The token implementation has one owner per concern:

| File                                                | Owns                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/design-tokens/src/tokens.css`             | Primitive and semantic default tokens, plus shared type, spacing, shape, elevation and motion scales. |
| `packages/design-tokens/src/palettes.css`           | Semantic colour overrides for the selectable palettes.                                                |
| `apps/admin/src/styles/globals.css`                 | The HeroUI and Tailwind bridge, plus small global structural rules.                                   |
| `apps/admin/src/lib/useTheme.ts` and `index.html`   | The light/dark preference and its pre-paint `dark` class.                                             |
| `apps/admin/src/lib/usePalette.ts` and `index.html` | The palette preference and its pre-paint `data-palette` attribute.                                    |

The focused token checks are
[`packages/design-tokens/scripts/verify-tokens.mjs`](../../packages/design-tokens/scripts/verify-tokens.mjs),
[`apps/admin/test/theme-tokens.spec.ts`](test/theme-tokens.spec.ts) and
[`apps/admin/test/palettes.spec.ts`](test/palettes.spec.ts). They measure the
token system; screen tests should verify user-visible behaviour instead of
copying CSS or class strings. Relevant decisions are [ADR 0005](../../docs/decisions/0005-theming-and-dark-mode.md), [ADR 0011](../../docs/decisions/0011-display-typeface.md) and [ADR 0012](../../docs/decisions/0012-selectable-palettes.md).

For ownership and API/runtime rules, see [`AGENTS.md`](./AGENTS.md).
