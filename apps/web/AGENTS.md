# Frontend agent contract

The repository `AGENTS.md` applies here. Before changing UI architecture, read
[`docs/frontend.md`](../../docs/frontend.md) and the
[component inventory](../../docs/frontend/components/README.md).

## Put code where its owner lives

- `app/pages/`: route metadata, route data and composition.
- `app/features/<domain>/`: framework-light schemas, types and pure helpers.
- `app/components/<domain>/`: domain UI and interaction boundaries.
- `app/components/ui/`: shared, domain-free `Jts*` product contracts.
- `app/composables/`: genuinely shared reactive state or app-facing facades.
- `app/plugins/`: integration bootstrap, not domain behavior.
- `app/theme/`: PrimeVue tokens; `app/assets/css/`: application layout and
  composition; `packages/design-tokens/`: framework-neutral visual values.

Do not create a shared abstraction before a second concrete use unless it owns
an explicit foundation contract already listed in the component inventory.
Keep one-off page logic explicit. Delete scaffolding for APIs that do not exist.

## Select components deliberately

1. Reuse a matching project component.
2. Otherwise use a PrimeVue primitive directly.
3. Compose a `Jts*` component only for repeated product behavior such as
   accessibility, loading/empty/error states or pagination.
4. Use semantic HTML/CSS for content and layout.

Pages own columns and business actions. Shared components do not hide API calls
or domain rules. Do not wrap PrimeVue merely to rename its props.

PrimeVue controls visible in server-rendered HTML belong in the explicit
allow-list in `nuxt.config.ts`; client-only or post-interaction controls use
local imports. Moving an SSR control to a local import can flash unstyled UI.
On an admin-only page, import every PrimeVue primitive used by that page locally,
even if the same primitive is globally allow-listed for public SSR.

## Preserve the route contract

Every page owns an accurate title, description and indexing policy. Keep one
`h1`, labelled controls, connected error text, keyboard-visible focus, status
text in addition to colour and reduced-motion behavior. Private or unfinished
routes need both robots metadata and the matching `X-Robots-Tag` route rule.
Admin route roots use the documented `admin-page-stack` layout class.

Treat API responses as `unknown` and parse them through the owning
`app/features/<domain>/` Zod schema before rendering. A TypeScript generic is
editor help, not runtime validation.

When a change alters structure, rendering, a reusable contract, configuration
or measured delivery constraints, update `docs/frontend.md` and/or the focused
component document in the same change.

Run `pnpm --filter @join-the-six/web lint`, `typecheck`, `test` and the relevant
`generate`/`build` check before handoff.
