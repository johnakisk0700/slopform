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
work. Keep page-specific behavior in the page that owns it.

Source: [CookbookPage.tsx](../../apps/admin/src/routes/CookbookPage.tsx).
