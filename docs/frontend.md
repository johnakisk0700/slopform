# Frontend foundation

Status: foundation decision, 2026-07-22.

The frontend is one Nuxt application in `apps/web`. It deliberately uses different rendering modes by route instead of maintaining separate Astro and Vue applications.

## Selected versions

| Package                     | Version | Reason                                                                                                                                                      |
| --------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nuxt                        |   4.5.0 | Current stable Nuxt release and the owner of routing, SSR, prerendering and the Vite build.                                                                 |
| Vue                         |  3.5.40 | Current stable Vue release; satisfies Nuxt 4.5's Vue 3.5 dependency.                                                                                        |
| PrimeVue                    |   4.5.5 | Latest MIT-licensed PrimeVue 4 release.                                                                                                                     |
| `@primevue/nuxt-module`     |   4.5.5 | Official module aligned exactly with PrimeVue 4.5.5.                                                                                                        |
| `@primeuix/themes`          |   2.0.3 | MIT theme package used by PrimeVue 4.5.5.                                                                                                                   |
| PrimeIcons                  |   7.0.0 | Latest MIT icon-font release compatible with the selected PrimeVue line.                                                                                    |
| Motion for Vue (`motion-v`) |   2.3.0 | Current stable Motion Vue package and Nuxt module.                                                                                                          |
| Zod                         |   4.4.3 | Current stable runtime validation library.                                                                                                                  |
| TypeScript                  |   6.0.3 | Newest stable version supported by the current `typescript-eslint` peer range (`<6.1`). TypeScript 7 is not yet a compatible choice for the lint toolchain. |
| Vitest                      |  4.1.10 | Current stable test runner, compatible with Nuxt's Vite generation.                                                                                         |
| Nuxt ESLint module          |  1.16.0 | Official project-aware flat ESLint configuration for Nuxt.                                                                                                  |

PrimeVue 5.0.0 is the registry's current overall release, but it moved from MIT to the PrimeUI licence and requires a licence key. Do not upgrade by accident. First confirm Community Licence eligibility or buy a Commercial Licence, then review the v5 migration guide and upgrade `primevue`, `@primevue/nuxt-module` and `@primeuix/themes` together. This is a commercial decision, not a dependency-bot checkbox.

The application requires Node `>=24.11 <25`. Nuxt 4.5 officially supports Node `^22.19.0 || ^24.11.0 || >=26.0.0`; the repository standardises on the Node 24 LTS line.

## Official documentation

Read these sources before extending the relevant area:

- Nuxt 4.5 directory structure: <https://nuxt.com/docs/4.x/directory-structure/>
- Nuxt rendering modes and route rules: <https://nuxt.com/docs/4.x/guide/concepts/rendering>
- Nuxt prerendering: <https://nuxt.com/docs/4.x/getting-started/prerendering>
- Nuxt data fetching: <https://nuxt.com/docs/4.x/getting-started/data-fetching>
- Nuxt custom fetch recipe: <https://nuxt.com/docs/4.x/guide/recipes/custom-usefetch>
- Nuxt runtime configuration: <https://nuxt.com/docs/4.x/guide/going-further/runtime-config>
- Nuxt route middleware: <https://nuxt.com/docs/4.x/directory-structure/app/middleware>
- Vue TypeScript Composition API: <https://vuejs.org/guide/typescript/composition-api>
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
- Vitest: <https://vitest.dev/guide/>

Exact versions were checked against the official npm registry metadata on 2026-07-22. Package pages:

- <https://www.npmjs.com/package/nuxt>
- <https://www.npmjs.com/package/vue>
- <https://www.npmjs.com/package/primevue>
- <https://www.npmjs.com/package/@primevue/nuxt-module>
- <https://www.npmjs.com/package/motion-v>
- <https://www.npmjs.com/package/zod>

## Rendering boundary

The boundary is route-based and explicit in `nuxt.config.ts`:

- `/admin` and `/admin/**`: client rendered with `ssr: false`. This is the data-heavy operations workspace. It may use PrimeVue tables, dialogs, drawers, toasts and restrained Motion layout animation.
- `/join/**`, `/register/**` and `/feedback/**`: SSR-capable public journeys. They must render a useful first response on the server. Do not read `window`, `localStorage` or browser-only SDKs during setup without a client guard.
- `/legal/**`: prerendered policy routes with `noScripts: true`. They contain no request-specific state and ship as static HTML without a hydration runtime.
- `/`: prerendered entry page.

`ssr: false` is not a general fix for hydration bugs. Move a route into the admin client boundary only when the route is genuinely an authenticated application screen. Public conversion and token routes remain SSR-capable.

## Layout and component conventions

- `app/layouts/default.vue` owns the public header, footer and content landmarks.
- `app/layouts/admin.vue` owns the operations shell and responsive navigation. Admin pages select it with `definePageMeta({ layout: 'admin' })`.
- Domain components belong under `app/components/<domain>/`; a page should orchestrate a route, not become a 1,500-line landfill.
- PrimeVue components are registered by the official Nuxt module from an explicit allow-list in `nuxt.config.ts`. Add a component to that list when it is first used; do not register the entire library or create a manual registration plugin.
- Extend the PrimeVue preset in `app/theme/jts-preset.ts`; `app/theme/jts-theme.ts` is the small Nuxt import wrapper. Keeping the theme behind the module's `importTheme` option avoids serialising the complete Aura preset into every public page's runtime configuration. Prefer PrimeVue semantic/component tokens over `:deep()` overrides or selectors that depend on generated component markup.
- Shared visual values live in `packages/design-tokens/src/tokens.css`. That package is framework-neutral CSS and must not import PrimeVue or Vue. Components consume semantic tokens such as `--jts-color-text`, not primitive palette values.
- Maintain the 16px browser root. The selected PrimeVue 4 theme is compatible with that baseline and a future v5 upgrade expects it.

The admin overview intentionally demonstrates a narrow set of foundation patterns: responsive navigation, Toolbar, DataTable, a Zod-validated Dialog form and Toast feedback. Its rows are labelled preview data and are not a speculative product dashboard.

## Motion and accessibility

`app/layouts/admin.vue` wraps only the admin application in `MotionConfig` with `reduced-motion="user"`; public routes do not pay for an animation library they do not use. Motion disables transform/layout animation when the operating system requests reduced motion. The global CSS also collapses CSS animation and transition durations under `prefers-reduced-motion: reduce`.

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
