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
- `environment.server.ts` / `environment.public.ts`: Zod contracts for private
  server and browser-visible runtime configuration.

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

This is an admin-only client application. Import every PrimeVue primitive
locally in the page, layout or component that uses it. Do not restore a global
component allow-list to accommodate a public route; public UI belongs to the
existing Next.js application at `legacy.example.com`.

## Preserve the route contract

Only `/admin` and `/admin/**` are application routes; `/` redirects to `/admin`.
Every page owns an accurate title, description and private indexing policy. Keep one
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

Add every environment variable to the owning Zod schema and matching
`.env.example`. Keep server-only variables out of `environment.public.ts`.
Validation must pass during Nuxt build/dev and again when the built Nitro server
starts, because production `NUXT_*` values can override the build defaults.

Run `pnpm --filter @join-the-six/web lint`, `typecheck`, `test` and `build`
before handoff.
