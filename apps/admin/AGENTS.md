# Admin frontend agent contract

The repository [`AGENTS.md`](../../AGENTS.md) applies here. `apps/admin` is the
live admin panel: a React 19 SPA (Vite) that replaced the retired Nuxt/PrimeVue
client (ADR 0006). Before changing UI architecture, read
[`docs/frontend/theming.md`](../../docs/frontend/theming.md) and
[ADR 0006](../../docs/decisions/0006-react-admin-runtime.md). Component
contracts live under `docs/frontend/components/`.

## Verified stack

| Library               | Version        | Docs                                       |
| --------------------- | -------------- | ------------------------------------------ |
| react / react-dom     | 19.2.8         | https://react.dev                          |
| @tanstack/react-query | 5.101.4        | https://tanstack.com/query                 |
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
| orval (dev)           | 8.23.0         | https://orval.dev                          |
| vite / vitest         | 8.1.5 / 4.1.10 | https://vite.dev                           |

Verified 2026-07-25 against `apps/admin/package.json`.

## Put code where its owner lives

| Path                     | Owns                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/generated/`     | orval output: TanStack Query hooks, models and Zod schemas. **Never edited by hand**; run `pnpm api:generate` from the repository root.              |
| `src/routes/`            | Pages: `usePageMeta`, data wiring, composition. They orchestrate; they do not absorb reusable table/form behavior.                                   |
| `src/features/<domain>/` | Client-only Zod schemas (drafts, persisted values) and pure logic. **Zero React imports.** Never a copy of a backend response shape.                 |
| `src/components/admin/`  | Admin shell and domain UI (`AdminShell`, `AdminNavigation`, `AdminUserMenu`, assistant chat composition).                                            |
| `src/components/ui/`     | Shared, domain-free `Jts*` contracts. They own repeated operational behavior (states, a11y, layout) — never domain data, fetching or business rules. |
| `src/lib/`               | Hooks and facades (`useTheme`, `usePageMeta`, `api`, `api-mutator`, `queryClient`, `env`).                                                           |
| `src/styles/globals.css` | The token bridge (HeroUI base tokens + Tailwind `@theme`). The only place colors are wired.                                                          |
| `index.html`             | Pre-paint theme script and the global `robots` meta.                                                                                                 |

Do not create a shared abstraction before a second concrete use unless it owns an
explicit foundation contract already listed in the component inventory. Keep
one-off page logic explicit; delete scaffolding for APIs that do not exist.

## Select components deliberately

**HeroUI first for interactive UI.** Buttons, menus, dialogs, drawers, selects,
tabs, tables, toasts, disclosures/accordions, and anything else with open/close,
focus, keyboard or motion behaviour come from `@heroui/react` so motion, focus
rings and a11y match the rest of the panel. Do **not** hand-roll native
`<details>`, custom dialogs, or home-grown expand/collapse when HeroUI already
ships the pattern (`Accordion` for a group, `Disclosure` for a single panel).
Style the HeroUI slots with tokens; do not reimplement the behaviour.

1. Reuse a matching `Jts*` component.
2. Otherwise use the HeroUI primitive — read installed declarations
   (`node_modules/@heroui/react/dist/…`) and
   [heroui.com docs](https://www.heroui.com/docs/react/components) before use.
3. Compose a documented `Jts*` only for a real repeated pattern (a11y,
   loading/empty/error, pagination) that HeroUI does not already own.
4. Semantic HTML/CSS only for inert content and layout (headings, lists, grids),
   not for interactive chrome HeroUI covers.

Pages own columns, cell formatting, filters, row actions and API calls. Shared
components do not hide fetching or domain rules. Do not wrap HeroUI merely to
rename its props. Props are the narrowest honest contract: no speculative
options, no `...rest` into the void, no boolean explosion where a variant union
reads better — slots and children over config objects.

## Tokens, HeroUI and accessibility

- **Tokens only.** Visual values come from `packages/design-tokens/src/tokens.css`
  (`--jts-*`) via the HeroUI mapping and Tailwind `@theme` bridge in
  `globals.css`. Use bridge utilities (`bg-surface`, `text-ink`, `text-primary`,
  `border-border`, `bg-copper-soft`, `text-sidebar-fg` …). Never raw
  hex/rgb/oklch, default Tailwind palette classes (`bg-red-500`, `text-slate-600`,
  `gray-*`) or inline style colors. Missing semantic → **stop and report**; do
  not hardcode and do not edit `packages/design-tokens/` for one component.
- **Dark mode** is the `dark` class on `<html>` (pre-paint in `index.html`, owned
  by `src/lib/useTheme.ts`). Tokens flip under it — no `dark:` color variants for
  values tokens already flip. `dark:` is for rare structural cases only.
- **HeroUI v3:** import from `@heroui/react`; read installed declarations
  (`node_modules/@heroui/react/dist/index.d.ts`) before use — no invented props,
  no v2/NextUI patterns. CSS-first: **no HeroUI provider**. Mount
  `<Toast.Provider />` once in `App.tsx` and fire with `toast()`. Icons:
  `lucide-react`; page entrance: `motion/react`.
- **A11y:** one `<h1>` per page; landmarks; focusable `#main-content`
  (`tabIndex={-1}`) with `skip-link` first. Native focus uses the global 2px
  `--jts-color-focus` ring (offset 3px); do not double-ring HeroUI. Icon-only
  controls need `aria-label`; current nav uses `aria-current="page"`; status is
  **text plus tone, never color alone**; toasts announce. Dual-mounted UI (e.g.
  operator menu in sidebar and small-screen top bar) must use `useId` for every
  internal id. Motion is only the 200ms opacity/8px-rise page entrance (respects
  `prefers-reduced-motion`), HeroUI transitions, shared `jts-breathe`
  (`.assistant-thinking`, `.jts-pending`), and one-shot `.jts-message-flash` on
  cited transcript reveal. WCAG AA holds via pre-verified tokens — another reason
  hardcoding color is banned.

## Types, API client, routes and environment

- **Strict TS:** `strict` plus `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals` /
  `noUnusedParameters`. No suppressions without a one-line WHY
  (`eslint-disable` / `@ts-expect-error` should be countable on one hand). No
  `any`, no unjustified `!`, no `as` where a type guard is honest.
- **Generated client:** call endpoints through `src/api/generated/` hooks
  (`useGetAuthSession`, …), named after backend `operationId`. Never hand-write
  a fetch, URL string or response Zod schema for an operation in
  `apps/backend/openapi/openapi.json` — missing endpoint → backend first, then
  `pnpm api:generate`. `RequireAdmin` is the reference consumer. Runtime
  browser validation (drafts, persisted values, echoed payloads) uses
  `src/api/generated/zod/`. Assistant screen owns hand-written client semantics
  beyond the response shape — not a pattern to copy (see root AGENTS.md).
- **Routes:** `/sign-in/*`, `/admin` and `/admin/**`; `/` → `/admin`; `*` →
  `ErrorPage`. Each view sets title/description via `usePageMeta`; `robots`
  (`noindex, nofollow`) is once in `index.html` — never re-touched per view.
- **Env:** only `import.meta.env.VITE_*` reaches the browser. Every consumed
  variable belongs in the Zod schema in `src/lib/env.ts` (fails fast at module
  load).

## Documentation and verification

Structure, reusable `Jts*` contracts, token/bridge vocabulary or measured
delivery constraints → update `docs/frontend/theming.md` and/or the focused
`docs/frontend/components/` contract in the same change.

Before handoff: `pnpm --filter @slopform/admin typecheck`, `lint`, `test`
and `build`. Shared conventions → `pnpm check`. Backend endpoint change →
`pnpm api:generate` first; commit regenerated contract with the change
(`pnpm check` fails on drift).
