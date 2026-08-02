# ADR 0012: Selectable palettes as a second appearance axis

- Status: Accepted
- Date: 2026-08-02
- Supersedes: the “single source of truth” scope of
  [ADR 0005](0005-theming-and-dark-mode.md), which now describes the shared and
  primitive layer plus the house theme rather than every colour on screen.

## Decision

The admin panel has **two independent appearance axes, and never a third**:

- `.dark` on `<html>` — the only dark-mode signal, exactly as ADR 0005 decided.
- `data-palette` on `<html>` — which of six themes is painted. The house theme,
  Join The Six, is the **absence** of the attribute, so with storage empty or
  unavailable the panel is exactly what `tokens.css` says.

`packages/design-tokens/src/palettes.css` holds the five non-default themes —
Graphite, Noir, Amphora, Linen, Iris — each as a light and a dark block. A block
repaints the **semantic colour layer only**. Type, space, radius, shadow, motion
and the primitives stay shared in `tokens.css` and are not themeable.

Every theme owns its brand colour. It states its own primary, accent, link,
focus and status tones, drawn from its own family.

Values in `palettes.css` are flat resolved hexes rather than references into a
second token graph. A theme is a finished coat of paint; giving it a parallel
graph would make six graphs to keep honest instead of one.

## Why

The first cut kept wine as the primary in all six, so whatever an operator
picked, the buttons and the chat bubbles stayed the same colour and only the
paper changed. That is not a theme, it is a background.

Two rules decide whether a set of tones may ship, and
`apps/admin/test/palettes.spec.ts` measures both in CIEDE2000 rather than by
comparing strings:

1. The five badge tones — info, success, warning, danger, accent — sit in one
   row of pills at 10px, so they must be at least **ΔE 12** apart. String
   inequality is not enough: Noir once shipped its accent and its warning as the
   same six hex digits, and before that the two differed by ΔE 3.8, which no
   operator can tell apart.
2. `primary` is a button, not a pill, so it answers to a looser **ΔE 10**
   against each status — far enough that "the thing you press" never reads as
   "something is wrong".

The light block is scoped `:not(.dark)` because it ties with `:root.dark` on
specificity and `palettes.css` imports after `tokens.css`. Without that guard a
theme's light values would win in dark mode.

`--jts-color-sidebar-active-index` exists because the sidebar is dark in **both**
modes, so a light theme's primary — dark ink meant for paper — cannot go on it.
Its value is fixed by rule and not by taste: the theme's own dark primary, in
both modes. The first cut let every theme invent a tint there and the numeral
became a colour that appeared nowhere else on screen.

## Consequences

- **A colour added only to `tokens.css` is correct in one theme of six.** This
  is the practical reversal of ADR 0005's single-source rule, and the reason
  this ADR exists. `packages/design-tokens/scripts/verify-tokens.mjs` warns when
  a palette defines only some of a set, because a partial palette is the
  previous theme showing through the gaps.
- Adding a semantic colour token now means adding it in six places, or
  deliberately deciding it is not themeable and saying so.
- `apps/admin/test/palettes.spec.ts` holds every theme to the same AA pairs the
  shipped tokens answer to, and to being distinct from one another. A theme that
  cannot pass does not ship.
- A pre-paint script in `apps/admin/index.html` stamps `data-palette` before
  first paint, mirroring the existing theme script, so a stored theme does not
  flash the house theme on load.
- The operator menu carries a **Theme** group beside the light/dark/auto
  control. The two axes are presented separately because they are separate.
- External scales carry their provenance: Amphora is Flexoki (Steph Ango),
  Linen is Radix Colors sand, Iris is Rosé Pine. Each was taken from its
  project's official source and then tuned where a borrowed value collided with
  a meaning — the collision rules above outrank fidelity to the original scale.

## References

- [ADR 0005](0005-theming-and-dark-mode.md) — the token system and the
  single dark-mode signal this builds on
- [Theming](../frontend/theming.md) — the working guide, including the six-theme
  table and the HeroUI/Tailwind bridge
- `packages/design-tokens/src/palettes.css`
- `apps/admin/src/lib/usePalette.ts`
- `apps/admin/test/palettes.spec.ts`
