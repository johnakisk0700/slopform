# ADR 0003: Nuxt rendering by route family

- Status: Superseded by [ADR 0004](0004-admin-only-boundary.md)
- Date: 2026-07-22
- Scope note: the Nuxt rendering policy is fully superseded by [ADR 0006](0006-react-admin-runtime.md) — the admin is now a React SPA with no server rendering.

## Decision

Use one Nuxt application with route-level rendering policy:

- `/admin/**`: client-heavy authenticated application; SSR can be disabled where it removes complexity without user-facing cost.
- `/join/**`, `/register/**`, `/feedback/**`: SSR-capable public forms for reliable first render and shareable entry points.
- policy/help pages: prerender where content and deployment allow it.

Business writes always cross the Nest API. Nuxt server routes may support web delivery concerns but do not become a second business backend.

## Supersession

The multi-family rendering policy described above was implemented before the
product ownership boundary was corrected. The Nuxt application now contains
only the client-rendered admin route family; public rendering belongs to the
existing Next.js application at `legacy.example.com`.

## Consequences

We keep one design system, deployment surface and Vue skill set while choosing rendering based on the route. Static rendering is a tool, not a religion—especially inside an admin panel where nobody wins a medal for prerendering a data table.
