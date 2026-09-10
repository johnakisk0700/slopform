# Admin cookbook

`/admin/cookbook` is a development-only gallery for inspecting shared components
and the current visual vocabulary. Both its route and navigation entry are gated
by `import.meta.env.DEV`; the page is loaded dynamically.

The [admin style guide](../../apps/admin/README.md) owns colors, spacing, type and
palettes. The [component inventory](components/README.md) owns reusable behavior.
Use the gallery to inspect changed components at narrow/wide widths, light/dark
mode, keyboard focus and reduced motion. Add a specimen when it helps review a
real component change; the gallery does not define a second design system.

Specimens use static local data and do not call domain APIs or start background
work. Each gallery section lives beside `CookbookPage.tsx` with its own specimen
state. Section metadata, frames and fixture data stay in that folder, grouped
by the vocabulary they demonstrate.

Source: [CookbookPage.tsx](../../apps/admin/src/routes/CookbookPage/CookbookPage.tsx).

The `#assistant-cards` anchor compares profile/event fields and conversations
with and without attention using the real assistant renderer. Sparse and
title-only examples verify that cards have no reserved body height. The motifs
section documents labelled attention, product marks and neutral outlines; the
metric specimens show neutral, success and warning icon tiles. Current visual
direction: [ADR 0022](../decisions/0022-admin-visual-language.md).
