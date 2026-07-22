# Architecture

## Core idea

The new application is a modular monolith with two executable surfaces: a Nuxt web application and a NestJS backend. The backend runs as separate HTTP and BullMQ worker processes but shares modules and domain contracts. PostgreSQL is the source of truth for the new domain.

```mermaid
flowchart LR
  Browser["Browser"] --> Web["Nuxt web\nadmin + public forms"]
  Web --> API["Nest HTTP API"]
  API --> DB[(PostgreSQL)]
  API --> Redis[(Redis)]
  Redis --> Worker["Nest BullMQ worker"]
  Worker --> DB
  Worker --> Providers["Email / messaging providers"]
  API -. "future narrow adapter" .-> WP["WordPress\ntemporary checkout + migration source"]
  WP --> Viva["Viva checkout"]
  API --> Obs["Logs / traces / errors"]
  Worker --> Obs
```

The foundation intentionally carries no WordPress URL, token or webhook secret.
Those runtime inputs belong to the future adapter and are added only when its
validated contract, ownership and rotation path exist. The diagram records the
migration boundary, not a currently deployed integration.

## Repository boundaries

| Location                 | Responsibility                                                       | Must not own                                  |
| ------------------------ | -------------------------------------------------------------------- | --------------------------------------------- |
| `apps/web`               | Routes, layouts, interaction, presentation and typed API consumption | Business invariants or direct database access |
| `apps/backend`           | HTTP contracts, use cases, authorization, jobs and integrations      | UI state or provider-specific domain models   |
| `packages/database`      | PostgreSQL schema, migrations and database client primitives         | Request/response DTOs or UI types             |
| `packages/design-tokens` | Shared visual tokens                                                 | Business data or backend dependencies         |

## Deployment units

- `web`: Nuxt server/output. Admin routes are client-heavy; public routes can use SSR or prerendering.
- `api`: Nest HTTP process. It validates input, enforces authorization and commits business state.
- `worker`: Nest application context consuming BullMQ queues. It must be independently deployable and horizontally scalable.
- `postgres`: durable product data and business audit events.
- `redis`: disposable queue coordination. It is not a business source of truth.

## Domain direction

The target entities come from the approved product contracts, not from WordPress tables:

- Participant and Consent
- Booking and PaymentLedgerEntry
- Event and Venue
- Table and TableAssignment
- Attendance
- Message
- Feedback and SafetyReport
- AuditEvent

These are a migration target, not permission to generate thirteen empty CRUD modules. Add them by vertical slice after field/status contracts are confirmed.

## Non-negotiable invariants

- Paid state is derived from verified, immutable ledger entries. A mutable `paid` boolean is not accounting.
- A booking is independent of an event/table assignment.
- A table has an enforced capacity and lifecycle; member arrays are not serialized into one column.
- Sensitive safety data is separated from ordinary feedback and has stricter access rules.
- State transitions that affect participants, money or outbound communication create an application audit event.
- Queue handlers are idempotent and retries are expected.
- External providers are adapters. Their payloads do not become the domain schema.

## Explicitly deferred

- Microservices and an event bus
- CQRS/event sourcing
- A generic repository framework
- A second CMS
- Automated WhatsApp/Viber sends before the approved human-review workflow exists
