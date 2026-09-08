# Admin frontend agent contract

The repository [`AGENTS.md`](../../AGENTS.md) applies here. `apps/admin` is the
live admin panel: a React 19 SPA (Vite) that replaced the retired Nuxt/PrimeVue
client (ADR 0006). Before changing UI architecture, read
[`docs/frontend.md`](../../docs/frontend.md). The canonical visual contract is
[`README.md`](README.md): spacing, type, color roles, tokens and palettes.
Component behavior lives under `docs/frontend/components/`. Dependency versions
come from `package.json` and the lockfile; inspect installed declarations before
using library APIs.

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

## Styling and accessibility

Follow the [style guide](README.md). Use existing semantic tokens; add a token
only for a present visual need with a clear role. Keep palette/scale rules in
that guide, and component behavior in its focused contract.

HeroUI v3 is CSS-first: no HeroUI provider. Mount `<Toast.Provider />` once in
`App.tsx`. Interactive primitives own keyboard, focus and motion behavior.
Keep one `h1` per page, labelled controls, the shell skip link and focusable
`#main-content`. Status needs text as well as color. Dual-mounted UI uses
`useId` for internal IDs; respect reduced motion.

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
  `pnpm api:generate`. `RequireAdmin` is the reference consumer. Validate untyped browser inputs and persisted drafts at entry; do not revalidate
  typed API responses or internal values. Assistant screen owns hand-written client semantics
  beyond the response shape — not a pattern to copy (see root AGENTS.md).
- **Routes:** `/sign-in/*`, `/admin` and `/admin/**`; `/` → `/admin`; `*` →
  `ErrorPage`. Each view sets title/description via `usePageMeta`; `robots`
  (`noindex, nofollow`) is once in `index.html` — never re-touched per view.
- **Env:** only `import.meta.env.VITE_*` reaches the browser. Every consumed
  variable belongs in the Zod schema in `src/lib/env.ts` (fails fast at module
  load).

## Documentation and verification

Update the [style guide](README.md) when the visual contract changes, and the
focused `docs/frontend/components/` contract when reusable behavior changes.

Before handoff: `pnpm --filter @slopform/admin typecheck`, `lint`, `test`
and `build`. Shared conventions → `pnpm check`. Backend endpoint change →
`pnpm api:generate` first; commit regenerated contract with the change
(`pnpm check` fails on drift).
