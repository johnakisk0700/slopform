# ADR 0004: Admin-only Nuxt application boundary

- Status: Accepted
- Date: 2026-07-22
- Scope note: the **ownership boundary** below stands unchanged — this
  repository owns the private admin, the public site is not ours. The
  **implementing framework** does not: `apps/web`, Nuxt and PrimeVue are
  superseded by [ADR 0006](0006-react-admin-runtime.md), and the surface
  described here is now `apps/admin`. It still carries `noindex, nofollow` and
  still redirects `/` to `/admin`. This ADR also narrowed the frontend scope of
  [ADR 0001](0001-platform.md) and the rendering policy of
  [ADR 0003](0003-rendering.md).

## Decision

This repository owns the private Join The Six administration and operations
application only.

- `apps/web` is a client-rendered, non-indexable Nuxt and PrimeVue admin panel.
- The existing Next.js application at `legacy.example.com` owns the public website,
  discovery, registration, intake and other participant-facing journeys.
- Public routes, public forms and public policy pages do not belong in
  `apps/web`.
- Participant, booking, feedback and safety records remain operational domain
  data. Staff manage them here even though their public collection UI lives in
  the Next.js application.
- Any future write from the public application to the Nest backend requires an
  explicit authenticated API, consent, abuse-control and failure contract.

The root route redirects to `/admin`. The entire Nuxt surface remains
`noindex, nofollow`; authentication and backend authorization are separate
required contracts and are not replaced by client route handling.

## Why

The public Next.js product already exists. Rebuilding its marketing and intake
journeys in Nuxt creates two sources of truth, duplicated policy surfaces and a
deployment boundary nobody asked for. This repository's product value is the
operator cockpit: events, bookings, payments, tables, attendance,
communications, feedback, safety and audit.

PrimeVue remains the admin component foundation. Project components may compose
PrimeVue when they own recurring operational behavior such as loading, empty,
error, pagination or accessibility states; they do not replace it with a
generic admin framework.

## Consequences

- The removed Nuxt public routes are not compatibility redirects. Public URLs
  are owned and served by `legacy.example.com`.
- Admin route metadata and response headers remain private by default.
- Frontend documentation, tests and bundle measurements cover the admin client
  only.
- Cross-application contracts must be documented when the public Next.js app
  starts writing to the operations backend.
