# ADR 0019: Application logging and nginx request logs

- Status: Accepted
- Date: 2026-09-08
- Scope: Operational logging, request logs and removal of unused tracing.
  Supersedes only ADR 0014's `OTEL_SERVICE_NAME` environment-key retention;
  the underlying Join The Six process identity values stay unchanged.

## Decision

Use one Pino-backed Nest logger for explicit application events and unexpected
errors. Keep request IDs, safe request context and credential redaction.
Nginx owns HTTP access records; Docker owns application log rotation. Host
logrotate owns nginx file retention. No automatic backend completion records,
OpenTelemetry/Sentry SDKs, tracing preload, exporters or telemetry shutdown hooks.
Startup failure still closes the application and writes a redacted fatal event
to stderr when the application logger may not be available.

`APP_NAME` replaces `OTEL_SERVICE_NAME` for PostgreSQL/MongoDB client and
materialization-pool identity. Copy custom values to the new key before deployment;
defaults and the production worker suffix remain unchanged. Other `OTEL_*` and
`SENTRY_*` settings are obsolete. Local dotenv loading stays before worker
decorator evaluation through an ordinary first entrypoint import.

## Why

The operator needs recent request records and useful application events. A
tracing system adds dependencies, startup ordering and lifecycle code without a
current consumer. Nginx already sees external requests; Docker already rotates
application output. Worker events still need application logging because nginx
cannot observe asynchronous work.

## Consequences

- Use `Logger` from `@nestjs/common` and `.log()`, `.warn()`, `.error()` or
  `.debug()` with useful internal identifiers. Existing feedback operation logs
  and durable audit/outbox records retain their contracts.
- Unknown HTTP errors still produce a safe 500 and an application error record.
- Native development has application logs but no automatic access log.
- Container logs are recent diagnostics and are lost when their container is
  removed; nginx files survive application deploys with bounded retention.
- Tracing can be reconsidered when a concrete diagnostic need justifies it.
- Deploy all components to install nginx logging before relying on it.

Implementation and verification: [runtime operations](../backend/mechanisms/runtime-operations.md)
and [deployment](../deployment.md#operational-logs).
