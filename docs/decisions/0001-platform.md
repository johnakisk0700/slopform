# ADR 0001: TypeScript modular-monolith platform

- Status: Accepted
- Date: 2026-07-22
- Scope note: frontend ownership narrowed by [ADR 0004](0004-admin-only-boundary.md).

## Decision

Use a pnpm/Turborepo monorepo on Node.js 24 LTS. Build the web application with Nuxt/Vue/PrimeVue and the backend with NestJS on its default Express adapter. Use PostgreSQL through Drizzle ORM and Redis/BullMQ for background work.

Deploy the Nest HTTP API and worker as separate processes from the same modular-monolith codebase.

## Why

- One language and repository make contracts, tooling and agent-assisted changes easier to review.
- Nuxt and PrimeVue directly fit the private, admin-heavy Vue application.
- Nest provides enough imposed structure for consistent controllers/modules/use cases without inventing an internal framework.
- Drizzle keeps schema and queries close to readable TypeScript and SQL.
- BullMQ gives retries, concurrency and operational visibility without demanding a distributed architecture.

## Rejected

- Astro: excellent content renderer, poor centre of gravity for an authenticated admin application.
- Next.js as the admin runtime: technically viable, but would replace the selected Vue UI stack. The existing Next.js application remains the correct owner for `legacy.example.com` public journeys under ADR 0004.
- Bun as the production runtime: possible later, but Node 24 has the least compatibility friction across Nest, Nuxt and observability tooling.
- Microservices: no demonstrated scaling or team boundary justifies their operational tax.
