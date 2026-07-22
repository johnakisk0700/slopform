# Frontend foundation

Status: accepted foundation, verified 2026-07-22.

The frontend is one Nuxt application in `apps/web`. Route rules select
prerendering, SSR or client rendering; there is no parallel frontend runtime.

## Start here

| Task                               | Location                                | First reference                                      |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| Add a route                        | `apps/web/app/pages/`                   | Existing sibling page and rendering table below      |
| Add a domain schema or pure helper | `apps/web/app/features/<domain>/`       | `features/registration/schema.ts`                    |
| Add domain UI                      | `apps/web/app/components/<domain>/`     | `components/registration/RegistrationForm.vue`       |
| Reuse or add shared UI             | `apps/web/app/components/ui/`           | [Component inventory](frontend/components/README.md) |
| Use a PrimeVue primitive           | Page or owning component                | PrimeVue registration policy below                   |
| Call the API                       | `app/composables/useApi.ts`             | `app/plugins/api.ts`                                 |
| Change application layout CSS      | `app/assets/css/main.css`               | Existing named section                               |
| Change a shared visual value       | `packages/design-tokens/src/tokens.css` | Token ownership below                                |
| Change PrimeVue appearance         | `app/theme/jts-preset.ts`               | PrimeVue theme tokens                                |
| Change route rendering or headers  | `apps/web/nuxt.config.ts`               | `routeRules`                                         |

Nuxt component discovery uses `pathPrefix: false`: the filename is the template
name and the directory expresses ownership. Keep component filenames globally
unique. Shared components use the `Jts*` prefix.

## Route rendering and metadata

| Routes                         | Rendering                    | Indexing                                                       |
| ------------------------------ | ---------------------------- | -------------------------------------------------------------- |
| `/`                            | Prerendered                  | Indexable                                                      |
| `/join/**`                     | SSR                          | Indexable when page metadata allows it                         |
| `/register/**`, `/feedback/**` | SSR                          | `noindex, nofollow` in HTML and response header                |
| `/legal/**`                    | Prerendered, scripts removed | `noindex, nofollow` in HTML and response header                |
| `/admin/**`                    | Client-rendered application  | `noindex, nofollow` response header; page metadata after mount |

Pages own their title, description and indexing policy. Indexable public routes
also own Open Graph and Twitter text. Canonical URLs and social images remain
absent until the application has a validated public-site origin and approved
asset. `WEB_ORIGIN` is a CORS allow-list, not a canonical URL.

The root app renders `NuxtRouteAnnouncer`. Both layouts and the standalone error
page provide a focusable `#main-content` target for the skip link. The admin SPA
loading template supplies a main landmark, busy status and no-script message
before hydration.

## Application boundaries

```text
app/
├── components/ui/          shared, domain-free Jts* contracts
├── components/<domain>/    domain UI and interaction boundaries
├── features/<domain>/      schemas, types and pure helpers
├── composables/            shared state and app-facing facades
├── layouts/                persistent public/admin shells
├── pages/                  route metadata, data and composition
├── plugins/                integration bootstrap
└── theme/                  PrimeVue preset and module import wrapper
```

`features/` has no Nuxt runtime behavior. Its files must be testable without a
Nuxt application. Pages orchestrate routes; they do not absorb reusable form or
table behavior. Conversely, shared UI must not hide domain API calls or business
rules.

Choose UI in this order:

1. Reuse a matching project component.
2. Use a PrimeVue primitive directly.
3. Compose a documented `Jts*` component when repeated product behavior is the
   real abstraction.
4. Use semantic HTML/CSS for content and layout.

The current shared contracts are `JtsPageHeader`, `JtsSurface`, `JtsStat` and
`JtsDataTable`. Their contracts are linked from the
[component inventory](frontend/components/README.md). Keep columns, cell
formatting, filters and row actions in the consuming feature. A wrapper that
only renames PrimeVue props is paperwork wearing a component costume.

Keep one-use route metadata, policy pages and domain-specific error mapping
explicit. Do not create page factories, metadata DSLs, barrels or generic
composables before a second concrete use demonstrates the common behavior.

## PrimeVue registration and theme

PrimeVue 4.5.5 is registered with `autoImport: false`. Components visible in
SSR markup are in the explicit `nuxt.config.ts` allow-list: `Button`,
`Checkbox`, `InputText`, `Select` and `Textarea`.

Admin-only `Avatar`, `Column`, `DataTable`, `DatePicker`, `Dialog`, `Drawer`,
`PanelMenu`, `Tag`, `Toast` and `Toolbar` use local imports. The client-only
`primevue-toast.client.ts` plugin installs `ToastService`; `useToast` remains an
explicit import. Add an SSR-visible primitive to the allow-list so its theme
styles exist before hydration. Keep a client-only or interaction-only primitive
local so it does not tax every rendered response.

The Nuxt module emits globally registered component styles into every SSR
response. With the current five-component allow-list, the generated inline
PrimeVue registry measured 78,737 raw bytes on public and legal routes; no
admin-only component style ID was present. The remaining registry is known
module-level debt. Do not set `loadStyles: false` without an equivalent SSR
stylesheet, and do not strip the response string.

Extend PrimeVue through `app/theme/jts-preset.ts`. `jts-theme.ts` is only the
Nuxt module import wrapper. Use semantic/component theme tokens or documented
pass-through attributes; avoid selectors coupled to generated DOM. The preset
and framework-neutral tokens both use system dark mode.

PrimeVue 5, PrimeUI themes 3 and PrimeIcons 8 use the PrimeUI licence and need a
licence decision. The current stack stays on MIT versions: PrimeVue and its
Nuxt module 4.5.5, `@primeuix/themes` 2.0.3 and PrimeIcons 7.0.0. Upgrade those
packages together, not as independent dependency-bot confetti.

## API, state and forms

`app/plugins/api.ts` provides `$api`, an `ofetch` instance with:

- `NUXT_API_BASE_INTERNAL` during SSR and `NUXT_PUBLIC_API_BASE` in browsers;
- credentialed requests, a 15-second timeout and no automatic retries;
- only `cookie` and `x-request-id` forwarded from inbound SSR requests.

`useApi()` is the application-facing seam for imperative calls. Use
`useFetch`/`useAsyncData` for SSR page reads so results enter the Nuxt payload.
Prefer a generated OpenAPI client or shared contract package once backend
contracts settle. Do not duplicate response interfaces casually.

There is no frontend authentication contract yet. Add session state and named
admin middleware only after matching backend endpoints and cookie policy exist.
Client route guards improve navigation; they do not authorise requests.

Zod schemas under `app/features/<domain>/` own client parsing and typed
payloads. The backend validates independently. Forms connect field errors with
`aria-describedby`, focus the first invalid field once submission exists,
preserve values on retryable failures and never render raw server messages. The
registration component is deliberately non-submitting until its backend and
policy contract exist. PrimeVue Forms remains absent: the current forms already
have one schema owner, and a second form-state system would duplicate it.

## CSS, tokens, fonts and motion

| Owner                                   | Responsibility                                                        |
| --------------------------------------- | --------------------------------------------------------------------- |
| `packages/design-tokens/src/tokens.css` | Used, framework-neutral semantic values and their required primitives |
| `app/theme/jts-preset.ts`               | PrimeVue primitive, semantic and component tokens                     |
| `app/assets/css/main.css`               | Shells, route composition and project-component layout                |
| Vue component styles/markup             | Domain-specific structure; no duplicated global token system          |

Components consume semantic variables such as `--jts-color-text`. Add a shared
token when at least two consumers need the same visual decision; remove dead
scale entries rather than treating the token file as a paint warehouse. Keep
PrimeVue out of the design-token package.

DM Sans Variable and Newsreader Variable 5.3.0 are self-hosted through
Fontsource under OFL-1.1. Only normal `wght` variable files are imported. System
and Georgia fallbacks remain available. Fonts are not preloaded without
route-level LCP evidence; hard-coding Vite asset hashes would be brittle.

Motion for Vue 2.3.0 is imported only by the admin layout/page. `MotionConfig`
uses `reduced-motion="user"`; public routes do not load the library. CSS also
collapses durations for `prefers-reduced-motion`. Use motion for continuity or
state change, not as decoration or the only status signal.

Every new UI preserves one logical `h1`, landmarks, explicit control labels,
keyboard-visible focus, status text in addition to colour, connected validation
errors and reduced-motion behavior. Preview data and unfinished policy copy must
remain visibly identified as such.

## Delivery constraints

Verified with Nuxt 4.5.0, Nitro 2.13.4, Vue 3.5.40 and Vite 8.1.5 on
2026-07-22:

- prerender payload extraction uses `"client"`: initial payloads stay embedded,
  while extracted payloads remain available for client navigation;
- the `build:manifest` hook removes entry dynamic-import prefetch hints and the
  unused PrimeIcons SVG fallback; active-route modulepreloads and NuxtLink
  route-aware prefetching remain;
- client source maps stay disabled and server maps enabled;
- Nitro produces the standalone Node server; Caddy owns compression;
- automatic chunk splitting remains; arbitrary manual vendor chunks would move
  bytes without removing them.

The client-only admin manifest closure measured 1,278,936 minified bytes
(326,471 gzip) across 20 CSS/JavaScript files. Its page entry was 551,970 bytes
(131,084 gzip). Before production use, measure browser startup. If it misses the
agreed budget, first isolate the interaction-only event dialog/date picker.

The production entry stylesheet measured 44,123 raw bytes (9,441 gzip),
including fonts, design tokens, PrimeIcons and application CSS. Keep one ordered
stylesheet until route-level transfer data justifies another request boundary.

Node must satisfy the repository engine `>=24.11 <25`. Nuxt also supports Node
22.19 and 26+, but this repository standardises on Node 24 LTS. `package.json`
and the lockfile are the source of truth for exact dependency versions.

## Verification and extension

From the repository root:

```bash
pnpm --filter @join-the-six/web lint
pnpm --filter @join-the-six/web typecheck
pnpm --filter @join-the-six/web test
pnpm --filter @join-the-six/web generate
pnpm --filter @join-the-six/web build
```

`build` is the production hybrid Nitro check. `generate` additionally verifies
static route output. For each vertical slice, confirm the backend/permission
contract, select route rendering, add the schema boundary, implement all useful
states, preserve accessibility, add accurate metadata and write the narrowest
test that protects the behavior.

## Official references

Library behavior was verified 2026-07-22 against:

- [Nuxt directory structure](https://nuxt.com/docs/4.x/directory-structure/)
- [Nuxt rendering modes](https://nuxt.com/docs/4.x/guide/concepts/rendering)
- [Nuxt data fetching](https://nuxt.com/docs/4.x/getting-started/data-fetching)
- [Nuxt SEO metadata](https://nuxt.com/docs/4.x/getting-started/seo-meta)
- [Nuxt TypeScript](https://nuxt.com/docs/4.x/guide/concepts/typescript)
- [PrimeVue DataTable](https://v4.primevue.org/datatable/)
- [PrimeVue accessibility](https://v4.primevue.org/guides/accessibility/)
- [Vue TypeScript Composition API](https://vuejs.org/guide/typescript/composition-api)
- [Zod documentation](https://zod.dev/)
