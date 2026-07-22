# Frontend agent contract

The repository `AGENTS.md` applies here. Read `docs/frontend.md` and
`docs/frontend/components/README.md` before changing UI architecture.

## Reuse hierarchy

Use this decision order for every screen:

1. Search `app/components/` and the component inventory. Prefer an existing
   `Jts*` UI component or domain component when its contract fits.
2. Use a PrimeVue component directly when it already solves the requirement.
3. Create a `Jts*` component under `app/components/ui/` when a real shared
   pattern adds behavior across screens. Build it from PrimeVue primitives where
   possible.
4. Use custom semantic HTML/CSS when the requirement is content/layout or when
   PrimeVue has no suitable accessible primitive.

Pages orchestrate data and domain actions. They must not reimplement shared
loading, empty, error, pagination, toolbar or field behavior. Domain components
live under `app/components/<domain>/`; framework-neutral visual tokens stay in
`packages/design-tokens`.

Reusable components must have:

- typed props, emits and intentionally named slots;
- explicit loading, empty, error and disabled behavior where applicable;
- keyboard/focus semantics and reduced-motion behavior;
- no hidden API calls or domain rules unless they are explicitly domain
  components;
- a short contract entry under `docs/frontend/components/` and an inventory
  update.

A reusable table should compose PrimeVue DataTable rather than replace it. It
may standardize loading, empty/error presentation, responsive overflow,
pagination and toolbar slots; column definitions and business actions remain
with the consuming feature.

## Visual direction

The product should feel warm, confident and human. The admin palette is
burgundy/rose/red with restrained cream or blush surfaces. Preserve contrast,
information density and status semantics; "cute" is not permission to make an
operations table look like a cupcake exploded on it.

Decorative art and fonts must be intentional, licensed for the intended use and
documented. Prefer performant self-hosted assets or a resilient system fallback.
Never make public form comprehension depend on decoration.
