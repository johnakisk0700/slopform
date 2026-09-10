# ADR 0022: Admin visual language

- Status: Accepted
- Date: 2026-09-10
- Supersedes: the Commissioner display-family decision in
  [ADR 0011](0011-display-typeface.md). Sora remains exclusive to the wordmark.

## Decision

The admin keeps its existing palettes, spacing scale, shapes, motion and HeroUI
primitives. Manrope now covers headings as well as UI and body. The display
token aliases the sans token; the unused Commissioner font dependency is
removed. Sora still sets the Slopform wordmark.

Metadata uses readable sentence-case labels. Navigation uses icons and names;
the numbered index, decorative page eyebrows and six-dot marks are retired.
An organic two-piece S replaces the form/chat mark. It uses filled curves
separated by an open channel, with the same SVG geometry in the app and
standalone exports. The rose/wine identity is independent of action colours;
the lower curve lifts on dark or strong surfaces, and Noir remains neutral.
Sora stays exclusive to the wordmark, including the mobile drawer and header.
Page titles retain a small decorative signature: a Lucide hashtag to the left,
in the existing accent colour, shared by standard and custom detail headers.
It carries no status meaning or accessible text and has no animation or underline.

Cards have neutral, uniform outlines. Attention uses a labelled icon and a
semantic soft fill. Assistant cards pair field labels with Lucide icons. Their
header groups a tinted identity icon, bold name and compact icon badges above a
separator. `Needs attention` is a danger-soft badge beside secondary state/control
badges. Each card fits its content height; missing fields leave no empty body.
Metric cards use icon tiles and their existing toned values. Domain status,
thresholds, field omission and parsing behavior do not change.

## Why

The portfolio presentation needs a recognisable product identity while keeping
the warm palette and existing component geometry. The previous combination of
tracked capitals, numbered navigation, title marks and coloured left borders
over-emphasised decoration. Icons now identify fields and actionable states.

## Compatibility and verification

The internal `sidebar-active-index` colour role becomes `sidebar-accent`, with
identical values and all CSS consumers updated in the same SPA. Persisted theme
keys, palette IDs and all other compatibility identifiers remain unchanged.

The favicon is transparent and lifts its lower curve for dark browser or
embedding surfaces. Its link is versioned for artwork changes. Shared brand
components use a compact mark-to-wordmark gap and carry the change to navigation,
login, auth states and errors; no authentication or routing behavior changes.

Inspect the real cookbook specimens in light/dark, each palette and a narrow
viewport; run `pnpm check`. Styling does not introduce source-string tests.
The [style guide](../../apps/admin/README.md) owns the operational rules.
