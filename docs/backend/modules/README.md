# Backend module inventory

Document product modules here when they own durable invariants, permissions or
lifecycle. Use the [documentation standard](../../documentation-standard.md)
and link the source module. Cross-cutting infrastructure belongs in
[mechanisms](../mechanisms/README.md).

No product module exists yet. `apps/backend/src/modules/reference/` is a
disposable executable pattern, not production CRUD. The first real vertical
slice should add its page, then remove the reference route, queue, processor and
table through a reviewed forward migration.

`REFERENCE_MODULE_ENABLED=true` adds only the reference HTTP adapter. Its worker
remains active to drain jobs accepted by an earlier release; disabling producers
must not strand a backlog.

The reference Core/HTTP/Worker split exists because one use-case service is
shared by two executable graphs. It is not a starter kit. A domain used in one
process normally has one Nest module; split adapters only to keep HTTP providers
out of workers or worker providers out of HTTP.
