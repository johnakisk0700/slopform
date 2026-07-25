# Admin frontend agent contract

The repository [`AGENTS.md`](../../AGENTS.md) applies here. `apps/admin` is the
live admin panel: a React 19 single-page app (Vite) that replaced the retired
Nuxt/PrimeVue client (see ADR 0006). Before changing UI architecture, read
[`docs/frontend/theming.md`](../../docs/frontend/theming.md) (tokens, the bridge
and dark mode) and
[ADR 0006](../../docs/decisions/0006-react-admin-runtime.md) (the React runtime
decision). Component contracts live under `docs/frontend/components/`.

## Verified stack

| Library               | Version        | Docs                                       |
| --------------------- | -------------- | ------------------------------------------ |
| react / react-dom     | 19.2.8         | https://react.dev                          |
| @clerk/react          | 6.12.6         | https://clerk.com/docs                     |
| @heroui/react         | 3.2.2          | https://www.heroui.com                     |
| tailwindcss           | 4.3.3          | https://tailwindcss.com                    |
| @tanstack/react-table | 8.21.3         | https://tanstack.com/table                 |
| react-router          | 7.18.1         | https://reactrouter.com                    |
| motion                | 12.42.2        | https://motion.dev                         |
| lucide-react          | 1.25.0         | https://lucide.dev                         |
| react-markdown        | 10.1.0         | https://github.com/remarkjs/react-markdown |
| mermaid               | 11.15.0        | https://mermaid.js.org                     |
| zod                   | 4.4.3          | https://zod.dev                            |
| vite / vitest         | 8.1.5 / 4.1.10 | https://vite.dev                           |

Verified 2026-07-23 against `apps/admin/package.json`.

## Put code where its owner lives

| Path                     | Owns                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/`            | Pages: `usePageMeta`, data wiring, composition. They orchestrate; they do not absorb reusable table/form behavior.                                   |
| `src/features/<domain>/` | Zod schemas and pure logic. **Zero React imports.**                                                                                                  |
| `src/components/admin/`  | Admin shell and domain UI (`AdminShell`, `AdminNavigation`, `AdminUserMenu`, assistant chat composition).                                            |
| `src/components/ui/`     | Shared, domain-free `Jts*` contracts. They own repeated operational behavior (states, a11y, layout) — never domain data, fetching or business rules. |
| `src/lib/`               | Hooks and facades (`useTheme`, `usePageMeta`, `api`, `env`).                                                                                         |
| `src/styles/globals.css` | The token bridge (HeroUI base tokens + Tailwind `@theme`). The only place colors are wired.                                                          |
| `index.html`             | Pre-paint theme script and the global `robots` meta.                                                                                                 |

Do not create a shared abstraction before a second concrete use unless it owns an
explicit foundation contract already listed in the component inventory. Keep
one-off page logic explicit; delete scaffolding for APIs that do not exist.

## Select components deliberately

1. Reuse a matching `Jts*` component.
2. Otherwise use a HeroUI primitive directly.
3. Compose a documented `Jts*` component only for a real repeated pattern
   (accessibility, loading/empty/error states, pagination).
4. Use semantic HTML/CSS for content and layout.

Pages own columns, cell formatting, filters, row actions and API calls. Shared
components do not hide fetching or domain rules. Do not wrap HeroUI merely to
rename its props. Props are the narrowest honest contract: no speculative
options, no `...rest` into the void, no boolean explosion where a variant union
reads better — slots and children over config objects.

## Tokens and the bridge are the only color vocabulary

- Every visual value comes from `packages/design-tokens/src/tokens.css` (`--jts-*`)
  through the HeroUI mapping and Tailwind `@theme` bridge in `globals.css`. Build
  with the semantic utilities that bridge exposes (`bg-surface`, `text-ink`,
  `text-primary`, `border-border`, `bg-copper-soft`, `text-sidebar-fg` …).
- Never write raw hex/rgb/oklch, default Tailwind palette classes (`bg-red-500`,
  `text-slate-600`, `gray-*`) or inline style colors. If a needed semantic does
  not exist, **stop and report it** — do not hardcode and do not edit
  `packages/design-tokens/` to patch a single component.
- Dark mode is the `dark` class on `<html>` (set pre-paint in `index.html`, owned
  by `src/lib/useTheme.ts`); the tokens flip under it. Components must not branch
  on theme: no `dark:` color variants for values the tokens already flip. `dark:`
  is reserved for genuinely structural cases, which should be rare to nonexistent.

## HeroUI v3 usage

- Import everything from `@heroui/react`. Read the installed declarations
  (`node_modules/@heroui/react/dist/index.d.ts`) before using a component or
  prop; do not invent props or copy patterns from HeroUI v2 / NextUI.
- HeroUI v3 is CSS-first — there is **no provider wrapper**. Do not add one.
- Toasts: mount `<Toast.Provider />` exactly once at the app root (`App.tsx`) and
  fire with `toast()`; do not mount a second provider.
- Icons come from `lucide-react`; the page-entrance animation from `motion/react`.

## Accessibility invariants

- One `<h1>` per page; landmark regions; a focusable `#main-content`
  (`tabIndex={-1}`) skip target with the `skip-link` as the first focusable
  element.
- Visible focus: native elements get the global 2px `--jts-color-focus` ring
  (offset 3px); HeroUI components manage their own — do not double-ring them.
- Icon-only controls carry `aria-label`; current nav item uses
  `aria-current="page"`; status is conveyed by **text plus tone, never color
  alone**; toasts announce.
- A component that mounts twice (the operator menu renders in both the sidebar
  and the small-screen top bar) must source every internal id from `useId`.
- `prefers-reduced-motion` collapses animation; the only motion is the 200ms
  opacity/8px-rise page entrance (which already respects it) and HeroUI's own
  transitions. WCAG AA holds in both themes because the tokens are pre-verified —
  another reason hardcoding color is banned.

## Types, routes and environment

- Strict TypeScript is on: `strict` plus the trio (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`) and `noUnusedLocals` /
  `noUnusedParameters`. Write code that passes without suppressions. Every
  `eslint-disable` / `@ts-expect-error` needs a one-line WHY and should be rare
  enough to count on one hand. No `any`, no non-null `!` without justification,
  no `as` where a type guard is honest.
- Treat API responses as `unknown` and parse them through the owning
  `src/features/<domain>/` Zod schema before rendering. A TypeScript generic is
  editor help, not runtime validation.
- Routes: only `/admin` and `/admin/**` exist; `/` redirects to `/admin`; unknown
  paths render `ErrorPage`. Each view sets its title and description via
  `usePageMeta`; `robots` (`noindex, nofollow`) is declared once in `index.html`
  and must not be re-touched per view.
- Only `import.meta.env.VITE_*` reaches the browser. Add every consumed variable
  to the Zod schema in `src/lib/env.ts`; it validates at module load and fails
  fast on a misconfigured deploy.

## Documentation and verification

When a change alters structure, a reusable `Jts*` contract, the token/bridge
vocabulary or measured delivery constraints, update `docs/frontend/theming.md`
and/or the focused `docs/frontend/components/` contract in the same change.

Run `pnpm --filter @join-the-six/admin typecheck`, `lint`, `test` and `build`
before handoff; run `pnpm check` when the change touches shared conventions.
