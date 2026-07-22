# Frontend foundation

Status: foundation decision, 2026-07-22.

The frontend is one Nuxt application in `apps/web`. It deliberately uses different rendering modes by route instead of maintaining separate Astro and Vue applications.

## Selected versions

| Package                        | Version | Licence    | Reason                                                                                                                                                      |
| ------------------------------ | ------: | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nuxt                           |   4.5.0 | MIT        | Current stable Nuxt release and the owner of SSR, prerendering and the Vite build.                                                                          |
| Vue                            |  3.5.40 | MIT        | Current stable Vue release; satisfies Nuxt 4.5's Vue 3.5 dependency.                                                                                        |
| Vue Router                     |   5.2.0 | MIT        | Current stable router selected by Nuxt 4.5 and declared directly as required by Nuxt's minimal application manifest.                                        |
| PrimeVue                       |   4.5.5 | MIT        | Latest MIT-licensed PrimeVue 4 release.                                                                                                                     |
| `@primevue/nuxt-module`        |   4.5.5 | MIT        | Official build-time module aligned exactly with PrimeVue 4.5.5.                                                                                             |
| `@primeuix/themes`             |   2.0.3 | MIT        | Last MIT theme major aligned with PrimeVue 4.5.5.                                                                                                           |
| PrimeIcons                     |   7.0.0 | MIT        | Last MIT icon-font major; every icon class used by the application exists in this release.                                                                  |
| Motion for Vue (`motion-v`)    |   2.3.0 | MIT        | Current stable runtime; imported explicitly only in the admin bundle.                                                                                       |
| Zod                            |   4.4.3 | MIT        | Current stable runtime validation library.                                                                                                                  |
| TypeScript                     |   6.0.3 | Apache-2.0 | Newest stable version supported by the current `typescript-eslint` peer range (`<6.1`). TypeScript 7 is not yet a compatible choice for the lint toolchain. |
| Vitest                         |  4.1.10 | MIT        | Current stable test runner; its Vite 6-8 peer range includes Nuxt 4.5's Vite 8 builder.                                                                     |
| Nuxt ESLint module             |  1.16.0 | MIT        | Current official project-aware flat ESLint configuration for Nuxt.                                                                                          |
| ESLint                         |  10.7.0 | MIT        | Current stable ESLint release and inside the Nuxt ESLint module's supported range.                                                                          |
| `vue-tsc`                      |   3.3.7 | MIT        | Current stable Vue type checker used by `nuxt typecheck`; supports TypeScript 5 and newer.                                                                  |
| Fontsource DM Sans Variable    |   5.3.0 | OFL-1.1    | Self-hosted variable sans for public body copy and dense admin UI.                                                                                          |
| Fontsource Newsreader Variable |   5.3.0 | OFL-1.1    | Self-hosted variable display serif for the public editorial voice.                                                                                          |

PrimeVue 5.0.0, `@primeuix/themes` 3.0.0 and PrimeIcons 8.0.0 are the
registry's current overall releases, but these majors moved from MIT to the
PrimeUI licence and require a licence key. Do not upgrade any member of the
Prime stack independently or by accident. First confirm Community Licence
eligibility or buy a Commercial Licence, then review the v5 migration guide and
upgrade `primevue`, `@primevue/nuxt-module`, `@primeuix/themes` and
`primeicons` together. This is a commercial decision, not a dependency-bot
checkbox.

Compatibility edges verified on 2026-07-22:

- Nuxt 4.5.0 requires Node `^22.19.0 || ^24.11.0 || >=26.0.0`, depends on Vue
  `^3.5.39` and Vue Router `^5.2.0`, and builds with Vite 8.
- Vue Router 5.2.0 accepts Vue `^3.5.34` and Vite `^7.3.0 || ^8.0.0`; Vue
  3.5.40 and Nuxt's Vite 8 satisfy both ranges.
- Vitest 4.1.10 accepts Vite 6, 7 or 8 and Node 20, 22 or 24+; it shares the
  Vite 8 generation selected by Nuxt rather than adding a second Vite pin.
- `@nuxt/eslint` 1.16.0 accepts ESLint 9 or 10. Its current
  `typescript-eslint` 8.65.0 resolution supports TypeScript
  `>=4.8.4 <6.1.0`, which is why this project stays on TypeScript 6.0.3 instead
  of registry-latest TypeScript 7.0.2.
- Motion for Vue 2.3.0 accepts Vue 3 and `@vueuse/core >=10`; pnpm resolves the
  peer to 14.3.0, whose Vue peer accepts Vue 3.5. The application does not
  import VueUse directly, so it is not duplicated in the application manifest.

`apps/web/tsconfig.json` uses Nuxt 4's generated app, server, shared and node
project references. The additional strict compiler options live in
`nuxt.config.ts`, where Nuxt can propagate them to each generated context;
do not add them back to the legacy aggregate `.nuxt/tsconfig.json` extension.
With project references present, `nuxt typecheck` runs `vue-tsc -b --noEmit`.

The application requires Node `>=24.11 <25`. Nuxt 4.5 officially supports Node `^22.19.0 || ^24.11.0 || >=26.0.0`; the repository standardises on the Node 24 LTS line.

## Official documentation

Read these sources before extending the relevant area:

- Nuxt 4.5 directory structure: <https://nuxt.com/docs/4.x/directory-structure/>
- Nuxt 4 package manifest: <https://nuxt.com/docs/4.x/directory-structure/package>
- Nuxt TypeScript and `vue-tsc`: <https://nuxt.com/docs/4.x/guide/concepts/typescript>
- Nuxt component discovery and naming: <https://nuxt.com/docs/4.x/directory-structure/app/components>
- Nuxt plugin registration and inferred types: <https://nuxt.com/docs/4.x/directory-structure/app/plugins>
- Nuxt rendering modes and route rules: <https://nuxt.com/docs/4.x/guide/concepts/rendering>
- Nuxt prerendering: <https://nuxt.com/docs/4.x/getting-started/prerendering>
- Nuxt data fetching: <https://nuxt.com/docs/4.x/getting-started/data-fetching>
- Nuxt custom fetch recipe: <https://nuxt.com/docs/4.x/guide/recipes/custom-usefetch>
- Nuxt runtime configuration: <https://nuxt.com/docs/4.x/guide/going-further/runtime-config>
- Nuxt route middleware: <https://nuxt.com/docs/4.x/directory-structure/app/middleware>
- Vue TypeScript Composition API: <https://vuejs.org/guide/typescript/composition-api>
- Vue single-file component organization: <https://vuejs.org/guide/scaling-up/sfc>
- PrimeVue 4 Nuxt installation: <https://v4.primevue.org/nuxt/>
- PrimeVue 4 styled theming: <https://v4.primevue.org/theming/styled/>
- PrimeVue 4 accessibility guide: <https://v4.primevue.org/guides/accessibility/>
- PrimeVue 4 DataTable: <https://v4.primevue.org/datatable/>
- PrimeVue 4 forms: <https://v4.primevue.org/forms/>
- PrimeVue 5 licence transition/current installation: <https://primevue.dev/nuxt>
- PrimeUI Community Licence: <https://primeui.dev/licenses/community>
- Motion for Vue and its Nuxt module: <https://motion.dev/docs/vue>
- Motion reduced-motion policy: <https://motion.dev/docs/vue-motion-config>
- Zod 4: <https://zod.dev/packages/zod>
- Nuxt ESLint module: <https://eslint.nuxt.com/packages/module>
- `typescript-eslint` supported versions: <https://typescript-eslint.io/users/dependency-versions/>
- Vitest: <https://vitest.dev/guide/>
- Fontsource variable fonts: <https://fontsource.org/docs/getting-started/variable>
- DM Sans installation: <https://fontsource.org/fonts/dm-sans/install>
- Newsreader installation: <https://fontsource.org/fonts/newsreader/install>

Exact versions were checked against the official npm registry metadata on 2026-07-22. Package pages:

- <https://www.npmjs.com/package/nuxt>
- <https://www.npmjs.com/package/vue>
- <https://www.npmjs.com/package/vue-router>
- <https://www.npmjs.com/package/primevue>
- <https://www.npmjs.com/package/@primevue/nuxt-module>
- <https://www.npmjs.com/package/@primeuix/themes>
- <https://www.npmjs.com/package/primeicons>
- <https://www.npmjs.com/package/motion-v>
- <https://www.npmjs.com/package/zod>
- <https://www.npmjs.com/package/typescript>
- <https://www.npmjs.com/package/vitest>
- <https://www.npmjs.com/package/@nuxt/eslint>
- <https://www.npmjs.com/package/eslint>
- <https://www.npmjs.com/package/vue-tsc>
- <https://www.npmjs.com/package/@fontsource-variable/dm-sans>
- <https://www.npmjs.com/package/@fontsource-variable/newsreader>

## Rendering boundary

The boundary is route-based and explicit in `nuxt.config.ts`:

- `/admin` and `/admin/**`: client rendered with `ssr: false`. This is the data-heavy operations workspace. It may use PrimeVue tables, dialogs, drawers, toasts and restrained Motion layout animation.
- `/join/**`, `/register/**` and `/feedback/**`: SSR-capable public journeys. They must render a useful first response on the server. Do not read `window`, `localStorage` or browser-only SDKs during setup without a client guard.
- `/legal/**`: prerendered policy routes with `noScripts: true`. They contain no request-specific state and ship as static HTML without a hydration runtime.
- `/`: prerendered entry page.

`ssr: false` is not a general fix for hydration bugs. Move a route into the admin client boundary only when the route is genuinely an authenticated application screen. Public conversion and token routes remain SSR-capable.

## Application structure and component conventions

Nuxt owns the runtime directories; the repository adds one deliberately small
domain seam inside them:

```text
app/
├── components/ui/            shared, domain-free Jts* contracts
├── components/<domain>/      domain UI with explicit props and events
├── features/<domain>/        framework-light schemas, types and pure helpers
├── composables/              shared reactive state and application facades
├── layouts/                  persistent public/admin shells
├── pages/                    route metadata, data orchestration and composition
└── plugins/                  integration bootstrap such as the configured API client
```

`features/` is a project convention, not a directory with Nuxt runtime magic.
Do not move pages, layouts, plugins or server endpoints into it. A feature file
must be safe to import in focused tests without constructing a Nuxt app; browser
state and network calls stay in components, composables or page orchestration.

Nuxt component discovery is configured with `pathPrefix: false`, so the filename
is the template name while subdirectories express ownership. Component filenames
must therefore remain globally unique and intentionally prefixed (`Jts*` for
shared UI, domain words for domain components). Nuxt 4.5.0's component discovery,
custom-directory and plugin typing guidance was rechecked on 2026-07-22.

- `app/layouts/default.vue` owns the public header, footer and content landmarks.
- `app/layouts/admin.vue` owns the operations shell and responsive navigation. Admin pages select it with `definePageMeta({ layout: 'admin' })`.
- Domain components belong under `app/components/<domain>/`; a page should orchestrate a route, not become a 1,500-line landfill.
- Before using PrimeVue directly, search the project component inventory in [`frontend/components/README.md`](frontend/components/README.md). Reuse an existing `Jts*` or domain component when its contract fits. Use PrimeVue directly when no project component fits; compose a documented `Jts*` wrapper only when it adds repeated product behavior such as standard loading, empty/error, pagination or accessibility states.
- Shared `Jts*` UI components live under `app/components/ui/`. They expose typed props/emits/slots and do not hide domain API calls. A wrapper that only renames PrimeVue props is abstraction-flavoured paperwork and should not exist.
- The current shared contracts are `JtsPageHeader`, `JtsSurface`, `JtsStat` and `JtsDataTable`; their focused contracts and selection guidance live in [`frontend/components/README.md`](frontend/components/README.md).
- PrimeVue components are registered by the official Nuxt module from an explicit allow-list in `nuxt.config.ts`. Add a component to that list when it is first used; do not register the entire library or create a manual registration plugin. The directive and composable allow-lists are empty because the application uses neither a global PrimeVue directive nor an auto-imported PrimeVue composable. `ripple: true` still enables the directives bundled locally by components such as Button. Including Toast also makes the module install ToastService; `useToast` remains an explicit import.
- Extend the PrimeVue preset in `app/theme/jts-preset.ts`; `app/theme/jts-theme.ts` is the small Nuxt import wrapper. Keeping the theme behind the module's `importTheme` option avoids serialising the complete Aura preset into every public page's runtime configuration. Prefer PrimeVue semantic/component tokens over `:deep()` overrides or selectors that depend on generated component markup.
- Shared visual values live in `packages/design-tokens/src/tokens.css`. That package is framework-neutral CSS and must not import PrimeVue or Vue. Components consume semantic tokens such as `--jts-color-text`, not primitive palette values.
- Maintain the 16px browser root. The selected PrimeVue 4 theme is compatible with that baseline and a future v5 upgrade expects it.

The admin overview demonstrates the shared page-header, stat and DataTable contracts alongside a Zod-validated Dialog form and Toast feedback. Every metric and row is labelled as local preview data; the page is not a speculative live dashboard.

## Visual system, typography and decoration

The product uses a warm burgundy/rose/cream system in both framework-neutral
tokens and the PrimeVue preset. Brand color does not replace status semantics:
green, amber and red remain reserved for success, warning and failure states.
Both light and system-dark schemes maintain separate surface and foreground
tokens. PrimeVue surfaces, fields, dialogs, toolbars, tables and tags are themed
through `definePreset`; arbitrary selectors into generated component markup are
not the theme API.

DM Sans Variable and Newsreader Variable are installed from Fontsource at exact
version 5.3.0. The packages self-host WOFF2 assets in the application build, so
no runtime font request leaves the site. Both fonts originate from the Google
Fonts catalogue and are distributed under the SIL Open Font License 1.1 by the
Fontsource packages. Only the normal `wght` variable files are imported;
resilient system/Georgia fallbacks remain in the design tokens. Package version,
license and Fontsource guidance were verified on 2026-07-22.

Public pages use Newsreader for display hierarchy and DM Sans for controls/body
copy. Admin uses DM Sans throughout for density and scan speed. Decorative table
and six-seat motifs are CSS-only, `aria-hidden` and optional to comprehension;
there are no remote images, hotlinks or image licensing dependencies.

The visual tokens live in
[`packages/design-tokens/src/tokens.css`](../packages/design-tokens/src/tokens.css),
while PrimeVue token mapping stays in
[`apps/web/app/theme/jts-preset.ts`](../apps/web/app/theme/jts-preset.ts). Keep
these layers semantically aligned instead of fixing a mismatch with isolated
hex values in pages.

## Motion and accessibility

`app/layouts/admin.vue` wraps only the admin application in `MotionConfig` with `reduced-motion="user"`; public routes do not pay for an animation library they do not use. Motion disables transform/layout animation when the operating system requests reduced motion. The global CSS also collapses CSS animation and transition durations under `prefers-reduced-motion: reduce`.

`MotionConfig` and `motion` are explicit imports from `motion-v`. The
`motion-v/nuxt` module is intentionally not enabled: its job is to register
Motion components and composables for auto-import, while every current Motion
consumer is already explicit. Add the module only if repeated auto-import usage
justifies the wider generated surface.

Use Motion only when it clarifies continuity, reordering or state change. PrimeVue's own transitions are enough for normal overlays. Do not animate every card entrance, and never use motion as the only status signal.

All new UI must preserve:

- a logical heading hierarchy and landmarks;
- explicit labels for controls;
- inline validation text connected with `aria-describedby`;
- keyboard-visible focus;
- text/status in addition to colour;
- `prefers-reduced-motion` behavior;
- no fake legal or consent copy presented as final.

## API and authentication seam

The Nest backend remains a separate service. `app/plugins/api.ts` provides `$api`, an `ofetch` instance configured from `NUXT_PUBLIC_API_BASE` in the browser and `NUXT_API_BASE_INTERNAL` during SSR. This lets containers use service DNS internally while browsers stay on the public origin. It uses `credentials: 'include'`, a finite timeout and no automatic mutation retries. During SSR it forwards only the inbound `cookie` and `x-request-id` headers, not the entire request header bag.

Nuxt infers the provided `$api` type from the plugin return value. `useApi()` is
the application-facing facade; do not maintain a duplicate module augmentation
unless a future integration cannot be represented by Nuxt's generated plugin
types.

Use `const api = useApi()` for imperative mutations. Use Nuxt `useFetch`/`useAsyncData` for page reads so SSR payloads are serialised and not fetched again during hydration. When the backend contract settles, prefer a generated OpenAPI client or shared contract package over copying response interfaces into pages.

`useAuth()` defines the session boundary (`GET /auth/session`, `POST /auth/logout`) but the foundation does not attach global auth middleware while the backend contract is still absent. Once the Nest endpoints exist:

1. Add named middleware to `/admin/**` that calls `useAuth().refresh()` once when session state is unknown.
2. Redirect unauthenticated users to the agreed login route.
3. Keep tokens in secure, HttpOnly, SameSite cookies. Do not store bearer tokens in local storage.
4. Protect the backend independently. A client-side route guard is navigation UX, not authorisation.

The production browser API base is `/api/v1`, which supports the Caddy same-origin reverse proxy. Local native/container development uses `http://localhost:4000/api/v1` in the browser; SSR uses `NUXT_API_BASE_INTERNAL` (`http://api:4000/api/v1` in Compose). If frontend and API use different public origins, configure credentialed CORS deliberately and verify SSR cookie forwarding for the chosen cookie domain.

TanStack Vue Query is intentionally absent. Nuxt's SSR-aware fetching plus `$api` covers the current foundation with fewer overlapping caches. Add Vue Query only when the admin has real cross-route server-state requirements such as shared query invalidation, optimistic mutations or background refetching. If added, keep it inside `/admin/**`; do not replace SSR-aware public reads reflexively.

## Validation and forms

Zod schemas own client-side form parsing and typed payloads. The backend must validate the same request independently. A schema returning success in the browser does not make the request trustworthy.

Keep domain form schemas near the feature (`app/features/<domain>/schema.ts`). Surface one useful error per field, focus the first invalid field when forms grow beyond this foundation, and map backend problem details to form/global errors without exposing raw server messages.

The current examples are the public registration schema and the admin-only
event-preview schema. The latter validates local fixture creation; it is not a
live events API contract.

## Commands

From the repository root:

```bash
pnpm install
pnpm --filter @join-the-six/web dev
pnpm --filter @join-the-six/web lint
pnpm --filter @join-the-six/web typecheck
pnpm --filter @join-the-six/web test
pnpm --filter @join-the-six/web build
pnpm --filter @join-the-six/web generate
```

`build` produces the hybrid Nitro application. `generate` is an additional static-generation check, not the production command for SSR routes.

## Extension checklist

For each vertical slice:

1. Confirm the Nest/OpenAPI contract and permission rule.
2. Add or reuse the Zod boundary schema.
3. Decide rendering from the route's user need, not from component-library convenience.
4. Implement loading, empty, error and success states.
5. Preserve keyboard, focus, labels and reduced-motion behavior.
6. Add a focused schema/service/component test and run lint, typecheck and build.
7. Do not claim preview fixtures are live product data.

## Explicit anti-patterns

- No second Astro application hiding beside Nuxt.
- No global `ssr: false`.
- No PrimeVue dependency inside `packages/design-tokens`.
- No arbitrary PrimeVue DOM overrides when a theme token or pass-through attribute exists.
- No business rules in table cell templates.
- No direct WordPress calls from Vue components. The Nest boundary owns legacy adaptation.
- No local-storage auth tokens.
- No duplicate server caches until invalidation requirements justify them.
- No unbounded motion, auto-playing decorative movement or interaction that depends on animation.
- No invented policy, consent, payment or safety wording promoted to production copy.
