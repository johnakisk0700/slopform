# ADR 0006: React admin runtime

- Status: Accepted
- Date: 2026-07-23

## Decision

The admin frontend is a React 19 single-page application built with Vite. It
replaces the Nuxt/Vue/PrimeVue admin (`apps/web`) with `apps/admin`.

- **UI framework:** React 19 with HeroUI v3 components on Tailwind CSS v4. HeroUI
  is CSS-first: its components read base tokens that we override, unlayered, with
  `var(--jts-*)` references, so the library derives from the existing token
  system rather than defining a second theme.
- **Tables:** operational tables pair a HeroUI skin with TanStack Table's
  headless core (`@tanstack/react-table`). HeroUI owns presentation; TanStack
  owns sorting, pagination and column state.
- **Routing:** React Router 7 in SPA (library) mode. There is no server runtime;
  business writes still cross the Nest API.
- **Design tokens:** `packages/design-tokens/tokens.css` is unchanged and remains
  the single source of truth. `apps/admin/src/styles/globals.css` is the bridge
  that feeds `--jts-*` into HeroUI base tokens and the Tailwind `@theme` layer.
- **Dark mode:** the `dark` class on `<html>`, applied pre-paint by a script in
  `index.html` and owned afterwards by `src/lib/useTheme.ts`. Tokens, HeroUI and
  Tailwind all flip off that one class.

## Why

- The public product at `legacy.example.com` is already React/Next.js. One UI
  framework across the organisation lets staff reuse already-built, tested React
  components instead of maintaining a parallel Vue skill set and component set.
- HeroUI v3's CSS-first theming consumes the existing `--jts-*` token system
  directly, so the token layer and the ADR 0005 dark-mode contract carry over
  with only the class name changing (`jts-dark` → `dark`).
- TanStack Table is headless, so operational tables keep the token-driven skin
  while gaining a well-tested interaction core.
- PrimeVue and Nuxt are removed; there is no styled-component framework to keep
  in agreement with the tokens.

## Consequences

- `apps/web` is retired. Its code is retained in git history and at checkpoint
  commit `6b387ac`; it is not deployed.
- Vue-specific documentation (Nuxt conventions, the PrimeVue integration) is
  superseded. Frontend handbooks and component contracts describe `apps/admin`.
- Deployment serves static SPA assets rather than a Nuxt server process. See
  [`../deployment.md`](../deployment.md).
- ADR 0003's Nuxt rendering policy is superseded by this ADR: there is no
  route-level rendering policy because there is no server rendering.
- The frontend halves of ADR 0001 (Nuxt/Vue/PrimeVue) are superseded. The
  backend stack — NestJS, PostgreSQL/Drizzle, Redis/BullMQ on the
  pnpm/Turborepo monorepo — is unchanged.
- ADR 0004's admin/public ownership boundary and ADR 0005's token and dark-mode
  contract both hold; only the implementing framework changed.

## Verified versions

Checked 2026-07-23 against `apps/admin/package.json`.

| Dependency              | Version | Reference                                        |
| ----------------------- | ------- | ------------------------------------------------ |
| React                   | 19.2.8  | <https://react.dev/blog/2024/12/05/react-19>     |
| HeroUI                  | 3.2.2   | <https://www.heroui.com/docs/guide/introduction> |
| Tailwind CSS            | 4.3.3   | <https://tailwindcss.com/blog/tailwindcss-v4>    |
| `@tanstack/react-table` | 8.21.3  | <https://tanstack.com/table/latest>              |
| React Router            | 7.18.1  | <https://reactrouter.com/home>                   |
| Vite                    | 8.1.5   | <https://vite.dev>                               |

## References

- [`../frontend.md`](../frontend.md) — admin conventions and extension guide.
- [ADR 0005](0005-theming-and-dark-mode.md) — token system and dark-mode signal.
