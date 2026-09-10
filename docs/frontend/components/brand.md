# Slopform brand

Status: current UI contract, updated 2026-09-10.

## Scope and ownership

The product mark is an organic S made of two filled curves with a transparent
channel between them. It replaces the form/chat mark. The
[approved imagegen reference](../assets/slopform-mark-reference.png) records
the selected silhouette; the shipped SVG redraw uses smooth cubic curves and
flat fills, without the raster background or texture.

| Owner                                                                                                                          | Responsibility                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [BrandMark.tsx](../../../apps/admin/src/components/admin/BrandMark.tsx)                                                        | Inline SVG geometry and surface-appropriate fills              |
| [BrandLockup.tsx](../../../apps/admin/src/components/admin/BrandLockup.tsx)                                                    | Mark, Sora wordmark, optional tagline and home link            |
| [brand-mark.svg](../../../apps/admin/public/brand-mark.svg)                                                                    | Self-contained transparent export for light surfaces           |
| [favicon.svg](../../../apps/admin/public/favicon.svg)                                                                          | Transparent browser/project icon with a dark-scheme lower fill |
| [tokens.css](../../../packages/design-tokens/src/tokens.css), [palettes.css](../../../packages/design-tokens/src/palettes.css) | Brand fills and their dark/Noir variants                       |

## Component contract

`BrandMark` takes `surface="default" | "strong"` and an optional `className`.
The default size is 36px. A supplied class includes the complete size override;
it does not recolour the mark through `currentColor`.

`BrandLockup` passes the surface to the mark. It uses 36px without a tagline,
40px with one, keeps a 6px mark-to-wordmark gap, and inherits the parent's
wordmark text colour. `to` makes the
lockup a home link named “Slopform admin home”; omit it for a static lockup.
The wordmark slot supports the mobile drawer's heading; that slot still uses
Sora (`font-brand`). Sora never sets ordinary UI copy.

The SVG is decorative (`aria-hidden`). The adjacent wordmark, link or sign-in
heading supplies its accessible name. The paths need no instance IDs or
external resources, so desktop and mobile instances can mount together.

## Colour and geometry

| Surface          | Upper curve        | Lower curve                                |
| ---------------- | ------------------ | ------------------------------------------ |
| Ordinary light   | `brand-upper` rose | `brand-lower` wine                         |
| Ordinary dark    | `brand-upper` rose | `brand-lower` resolved to text             |
| Sidebar / strong | `brand-upper` rose | `brand-inverse` resolved to text-on-strong |

The identity stays rose/wine across palettes; Noir substitutes neutral fills.
The [style guide](../../../apps/admin/README.md) owns these semantic roles.
The standalone brand export carries fixed light-surface colours. The favicon
has no background: it keeps the rose upper curve and changes the lower curve
from wine to the exported inverse fill under `prefers-color-scheme: dark`.
The [embedded SVG colour scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme#embedded_elements)
follows its host surface; browser favicons follow the browser's scheme. These
self-contained fills need no application stylesheet. `index.html` versions
the favicon link when the artwork changes.

The root [t3.json](../../../t3.json) points T3 Code's project icon at the same
favicon. Its explicit `iconPath` covers the monorepo location under `apps/admin`,
which T3 Code's built-in icon discovery does not search. A custom icon selected
in T3 Code's project settings takes precedence over this repository default.

Keep the same viewBox and two paths in all three SVG owners. Preserve the
rounded silhouette and open, flowing channel when editing the geometry.
Do not resize the two pieces independently or close the gap for small icons.
The login watermark uses the same upright mark at low opacity.

## Consumers and verification

The desktop sidebar, mobile header and drawer, sign-in layout, private-route
wait, auth status and error screen all use the shared components. The cookbook
shows ordinary and strong lockups plus 16, 24, 36 and 64px marks. Missing app
data or a failed auth check does not affect this local asset.

Inspect the cookbook in light/dark across all six palettes, mobile navigation,
the sign-in layout and standalone favicon. Run `pnpm check`; styling and SVG
path strings do not warrant a separate test suite.

Decision: [ADR 0022](../../decisions/0022-admin-visual-language.md).
