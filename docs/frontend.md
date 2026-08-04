# Frontend foundation

Status: accepted admin-only foundation, verified 2026-07-25.

`apps/admin` is the private Join The Six administration panel: a React 19 SPA
(Clerk 6, HeroUI v3, Tailwind CSS v4, TanStack Query/Table, React Router 7,
Vite). It replaced the retired Nuxt/PrimeVue client (historical;
[ADR 0006](decisions/0006-react-admin-runtime.md)). Public journeys stay on the
Next.js product at `legacy.example.com`
([ADR 0004](decisions/0004-admin-only-boundary.md)).

Editing rules live in [`apps/admin/AGENTS.md`](../apps/admin/AGENTS.md). This
page maps ownership, routes, transport and delivery constraints, and points at
focused contracts.

## Start here

| Task                               | Location                                      | First reference                                              |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Add an admin route                 | `apps/admin/src/routes/`                      | `OverviewPage.tsx` + route table in `App.tsx`                |
| Overview landing                   | `routes/OverviewPage.tsx`                     | [Overview](frontend/overview.md)                             |
| AI assistant                       | `routes/AssistantPage.tsx`                    | [Assistant](frontend/assistant.md)                           |
| Feedback inbox                     | `routes/FeedbackInboxPage.tsx`                | [Feedback conversations](frontend/feedback-conversations.md) |
| Outbound queue                     | `routes/FeedbackOutboxPage.tsx`               | [Outbound queue](frontend/feedback-outbound-queue.md)        |
| Domain schema / pure helper        | `features/<domain>/`                          | `features/event/eventStatus.ts`                              |
| Domain UI                          | `components/admin/`                           | `AdminNavigation.tsx`                                        |
| Shared UI                          | `components/ui/`                              | [Component inventory](frontend/components/README.md)         |
| HeroUI primitive                   | Owning route or component                     | `@heroui/react`                                              |
| Call a backend endpoint            | `api/generated/`                              | [API contract](backend/mechanisms/api-contract.md)           |
| Transport / env policy             | `lib/api.ts`, `lib/env.ts`                    | Env table below                                              |
| Regenerate API client              | `pnpm api:generate` (root)                    | [API contract](backend/mechanisms/api-contract.md)           |
| Theme / dark mode / tokens         | `useTheme.ts`, `globals.css`, design-tokens   | [Theming](frontend/theming.md)                               |
| Routing / redirect / 404           | `App.tsx`                                     | Route table below                                            |
| Dev proxy / build                  | `vite.config.ts`                              | Delivery constraints below                                   |

Imports are explicit (no filename discovery). Shared components use the `Jts*`
prefix: one file, named export matching the filename; export types only when a
consumer needs them.

## Product and route boundary

| Route                                 | Behavior                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/sign-in/*`                          | Clerk sign-in frame (page `h1`, form placeholder while loading, service-failure state)        |
| `/`                                   | Protected redirect to `/admin`                                                                |
| `/admin`                              | Clerk + backend admin check → Overview ([contract](frontend/overview.md))                     |
| `/admin/assistant`                    | New AI conversation                                                                           |
| `/admin/assistant/:threadId`          | Durable thread resume (`assistant/:threadId?` in `App.tsx`)                                   |
| `/admin/events`                       | Stub event list and create                                                                    |
| `/admin/events/:eventId`              | Edit, status transitions, attendance                                                          |
| `/admin/participants`                 | List + feedback WhatsApp opt-in                                                               |
| `/admin/participants/:id`             | Profile, Preferences opt-in, dinner history                                                   |
| `/admin/feedback`                     | Campaign picker                                                                               |
| `/admin/feedback/:campaignId`         | Three-pane inbox                                                                              |
| `/admin/feedback/:campaignId/results` | Campaign answers and notes                                                                    |
| `/admin/outbound`                     | Outbound queue (not under `feedback/`, so nav `aria-current` stays unambiguous)               |
| `/admin/docs/feedback`                | Operator map (`FeedbackMechanismPage`)                                                        |
| `/admin/cookbook`                     | **Dev only** — `import.meta.env.DEV` gallery ([contract](frontend/admin-cookbook.md))         |
| `*`                                   | Standalone 404 (`ErrorPage.tsx`)                                                              |

`noindex, nofollow` is one static meta in `index.html` for the whole SPA. Do not
add `/join`, `/register`, `/feedback`, marketing or public legal routes here.

Each view sets title/description via `usePageMeta` (never robots) and owns one
`h1`. The shell owns `#main-content`, skip link, nav, operator menu (sidebar
footer; top bar on small screens), drawer, `<Toast.Provider />` and
reduced-motion. Accessibility invariants:
[`apps/admin/AGENTS.md`](../apps/admin/AGENTS.md).

`RequireAdmin`: Clerk session, then `useGetAuthSession`; only a backend-approved
subject reaches the shell. Client guard improves navigation only — Nest
authorizes every API request
([authentication](backend/mechanisms/authentication.md)).

While Clerk loads, paint the URL's promise: `/sign-in/*` → `SignInLayout` +
`SignInFormPlaceholder`; elsewhere → `AuthPendingScreen`. `SignInLayout` lives
outside the router so waiting and routed sign-in share one frame.
`AuthStatusScreen` covers `configuration` / `denied` / `failed`. Style Clerk
`elements` with CSS objects (unlayered Clerk CSS outranks Tailwind layers).

## Application boundaries

```text
src/
├── api/generated/          orval output (never edited)
├── components/ui/          shared, domain-free Jts* contracts
├── components/admin/       admin shell and domain UI
│   └── RequireAdmin.tsx    Clerk + backend authorization gate
├── features/<domain>/      client-only schemas and pure helpers (no React)
├── lib/                    api, api-mutator, env, queryClient, useTheme, usePageMeta, …
├── routes/                 page metadata, data wiring, composition
├── styles/globals.css      token bridge + base layer + motifs
├── theme/                  reserved (empty); HeroUI mapping is in globals.css
├── App.tsx                 skip link, Toast.Provider, route table
└── main.tsx                StrictMode + QueryClientProvider + ClerkProvider
```

Routes orchestrate; they do not absorb reusable table/form behavior. Shared UI
does not hide domain API calls or business rules. UI selection order (full
detail in `AGENTS.md`): reuse `Jts*` → HeroUI primitive → new documented `Jts*`
only for repeated operational behavior → semantic HTML/CSS. Columns, filters,
cells and row actions stay on the consumer
([inventory](frontend/components/README.md)). Do not wrap HeroUI only to rename
props.

## HeroUI and theme

HeroUI v3 is CSS-first: import from `@heroui/react`, `@heroui/styles` once in
`globals.css`. **No app provider.** Mount `<Toast.Provider />` once in `App.tsx`
and fire `toast()`. Icons: `lucide-react`. Classes: `clsx`.
`tailwind-variants` is HeroUI's, not ours.

Appearance goes through the `globals.css` token bridge — no theme preset.
HeroUI base tokens map to `var(--jts-*)` and flip with `:root.dark`. Prefer
semantic bridge utilities over DOM-coupled selectors. Ownership, dark mode and
the `dark:` ban: [theming](frontend/theming.md),
[ADR 0005](decisions/0005-theming-and-dark-mode.md).

`JtsDataTable` = TanStack Table core + HeroUI `Table` (`ColumnMeta.align` is the
only type hatch). Routing: React Router 7 `BrowserRouter` — no data router/loaders.
`NavLink` → `aria-current`; `<Outlet>` in the shell's animated main.

Upgrade `@heroui/react` and `@heroui/styles` together. Exact versions:
`package.json` / `pnpm-lock.yaml` (stack table in `AGENTS.md`).

## API, state and forms

`src/lib/api.ts`: one `ofetch` with `baseURL = env.apiBase`, Clerk
`Authorization` + `credentials: "include"`, `retry: 0`, 15s timeout.

`src/lib/env.ts` Zod-validates at module load. Only `import.meta.env.VITE_*`
reaches the bundle — always go through `env`.

| Variable                     | Role                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `VITE_API_BASE`              | Optional; defaults `/api`; safe root-relative or HTTP(S) URL                                 |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk public-key shape when present; omit only for credential-free CI → configuration screen |
| `VITE_GOOGLE_MAPS_API_KEY`   | Optional Places UI Kit / Embed; absent → Place ID + Maps deep-links                          |
| `VITE_AUTH_DEV_BYPASS`       | Dev-only (`superRefine` rejects elsewhere). Removes auth — not a stub                        |

Bypass on: `/sign-in/*` → `/admin`, `DevelopmentBypassApp` with no
`ClerkProvider`, API skips `getToken()`.

Places (prototype; legal/provider gate in [deployment](deployment.md)): key
present → isolated Places autocomplete + one post-select `Place.fetchFields`;
list pills and ordinary event renders do not load Maps JS. Do not retain Google
content outside its session.

```mermaid
flowchart LR
  build["Build env / .env\nAPI base + public browser keys"] --> expose["import.meta.env.VITE_*"]
  expose --> zod["Zod validateEnv()"]
  zod --> base["env.apiBase (defaults to /api)"]
  zod --> clerk["ClerkProvider or configuration screen"]
  zod --> places["Optional isolated Places UI Kit adapter"]
  base --> client["ofetch api client"]
  hooks["Generated hooks → apiRequest mutator"] --> client
  client --> proxy["Vite dev proxy or native nginx → backend"]
```

### Generated client

Every OpenAPI operation is a named typed hook. Do not hand-write fetch, URL or
response Zod for a documented operation.

```tsx
import { useGetAuthSession } from "../../api/generated/auth";

const session = useGetAuthSession({ query: { enabled: isSignedIn } });
```

- `src/api/generated/` — orval hooks / `model/` / `zod/`. **Not committed**
  ([ADR 0010](decisions/0010-generated-client-not-committed.md)); run
  `pnpm api:generate`. Never hand-edit.
- Names from backend `operationId`. Missing endpoint → backend first, then
  regenerate.
- Calls go through `api-mutator.ts` → `api`; auth/retry/timeout stay in `api.ts`.
- One `QueryClientProvider` (`queryClient.ts`); query/mutation retries off.
  Screens own loading/empty/error.
- Runtime validation of drafts/persisted/echoed values: generated schemas from
  `api/generated/zod/`. `features/` never mirrors backend response shapes.

```bash
pnpm api:generate   # openapi.json + client
pnpm api:check      # fails on drift (inside pnpm check)
```

See [API contract](backend/mechanisms/api-contract.md) and
[ADR 0009](decisions/0009-generated-api-client.md). `RequireAdmin` is the
reference consumer.

Exactly **two** direct-transport exceptions (enforced by
`apps/admin/test/feedback-inbox.spec.ts`):

| Exception | Why | Contract |
| --------- | --- | -------- |
| Assistant | SSE + polling beyond response shape | [assistant.md](frontend/assistant.md) |
| Dev feedback simulator (`lib/feedbackSimulator.ts`) | Outside production under `TRANSPORT_MODE=simulated`; not in OpenAPI | [feedback-conversations.md](frontend/feedback-conversations.md) |

Not patterns to copy. A third entry means a product endpoint bypassed the client.

Forms: `aria-describedby`, focus first invalid field, preserve values on
retryable failure, never raw server messages. Preview-only UIs must say they do
not persist (Overview event dialog is the reference).

## CSS, tokens, fonts and motion

| Owner                                   | Responsibility                                                         |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `packages/design-tokens/src/tokens.css` | `--jts-*`; light + `:root.dark` flip                                   |
| `apps/admin/src/styles/globals.css`     | HeroUI overrides, `@theme inline`, base layer, sanctioned motifs       |
| Markup                                  | Semantic utilities only — no raw hex, no default Tailwind palette      |

`globals.css` header documents the layering. Sanctioned classes: `.skip-link`,
`.brand-mark`, `.status-dot`. Fonts / wordmark: [ADR 0011](decisions/0011-display-typeface.md).
Logo: `BrandLockup` / `BrandMark`; `.brand-mark` is decorative.

Dark mode: `dark` on `<html>` (pre-paint in `index.html`, then `useTheme.ts`).
Motion: 200ms opacity/8px-rise page entrance (`motion/react`, route-surface key,
`useReducedMotion`) + HeroUI transitions; `prefers-reduced-motion` collapses
animation. Assistant threads share the `/admin/assistant` surface key —
[assistant.md](frontend/assistant.md). Full token rules:
[theming](frontend/theming.md).

New screens: one `h1`, landmarks, labels, visible focus, status text plus tone,
reduced-motion. Preview data stays visibly identified until a real API owns it.

## Delivery constraints

Verified 2026-07-25 (React 19.2.8, Clerk 6.12.6, HeroUI 3.2.2, Tailwind 4.3.3,
TanStack Query 5.101.4, Table 8.21.3, React Router 7.18.1, Vite 8.1.5, orval
8.23.0, Zod 4.4.3):

- static SPA; `build` = `tsc -b --noEmit && vite build`;
- `index.html`: pre-paint theme, focusable `#main-content` fallback, `<noscript>`;
- every route is React-lazy. Measured production chunks: entry ~173.53 kB
  (~55.73 kB gzip), Overview ~159.11 kB (~49.87), Assistant ~362.53 kB (~111.46),
  events/participants ~2–6 kB, shared table/header ~154.92 kB; Rolldown splits
  Clerk (`auth` ~92.47), HeroUI (`ui` ~65.62), Assistant Markdown
  (`markdown` ~168.84, Assistant-only);
- Mermaid parser ~662.68 kB (~143.23 gzip), dynamic-import only for fenced
  Mermaid in assistant messages; Vite advisory 700 kB; no hard app-wide budget;
- CSS ~455.65 kB (~50.13 gzip); fonts/Mermaid assets separate; source maps off;
- dev: port 3000 proxies `/api` → `localhost:4000` (`API_PORT`, `changeOrigin`);
  3000 is CORS-trusted `WEB_ORIGIN`. Prod: nginx reverse-proxies `/api` for the
  same same-origin contract.

Engines: Node `>=24.11 <25`, pnpm `>=10.33 <11`.

## Verification

```bash
pnpm --filter @join-the-six/admin lint
pnpm --filter @join-the-six/admin typecheck
pnpm --filter @join-the-six/admin test
pnpm --filter @join-the-six/admin build
```

`pnpm check` runs those plus `pnpm api:check`. Vitest (node, no DOM) covers
delivery invariants, generated-client wiring, `resolveTheme`, and token WCAG AA.

Per vertical slice: permission contract → generated hooks → loading/empty/error →
a11y → private metadata → narrowest protecting test.

## Official references

Verified 2026-07-25:
[HeroUI v3](https://v3.heroui.com/docs/introduction) ·
[Tailwind v4 theme](https://tailwindcss.com/docs/theme) ·
[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview) ·
[TanStack Table](https://tanstack.com/table/v8/docs/framework/react/react-table) ·
[orval](https://orval.dev/reference/configuration/overview) ·
[React Router v7](https://reactrouter.com/) ·
[Clerk React](https://clerk.com/docs/react/getting-started/quickstart) ·
[Vite](https://vite.dev/guide/build.html) ·
[Rolldown splitting](https://rolldown.rs/in-depth/manual-code-splitting) ·
[Vite proxy](https://vite.dev/config/server-options.html#server-proxy) ·
[Vite env](https://vite.dev/guide/env-and-mode.html) ·
[Zod](https://zod.dev/)
