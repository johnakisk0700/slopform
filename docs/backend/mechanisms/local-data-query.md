# Local data query helper

## Purpose and boundary

[`scripts/local-data-query.mjs`](../../../scripts/local-data-query.mjs) gives
developers and coding agents one stable command for inspecting the local
PostgreSQL, MongoDB and Redis stores via Docker Compose — without rediscovering
container names, ports or credentials.

It is strictly a local-development tool. It does not accept remote connection
strings and is not a production operations interface.

## Public contract

```sh
pnpm db:query postgres '<SQL>'
pnpm db:query mongo '<mongosh expression>'
pnpm db:query redis <COMMAND> [ARG...]
pnpm db:query --write <postgres|mongo|redis> <query or command>
```

Examples:

```sh
pnpm db:query postgres \
  'select id, preferred_name from participants order by created_at desc limit 10'

pnpm db:query mongo \
  'db.conversation_threads.findOne({_id: "..."}, {messages: 1, needsAttention: 1})'

pnpm db:query redis HGETALL feedback:extract:job-id
```

Read-only is the default:

- PostgreSQL runs inside `BEGIN TRANSACTION READ ONLY` and always rolls back.
- MongoDB rejects known mutating APIs before invoking `mongosh`.
- Redis accepts only an explicit allowlist of read commands.

`--write` is required for mutations. Resolve the exact target with a read first;
avoid broad filters, wildcards and database-wide commands. The flag guards
against accidents — it is not permission for unrelated changes.

## Failure states

- Compose fails clearly if the local service is not running; start with
  `pnpm infra:up`.
- PostgreSQL stops on the first SQL error (`ON_ERROR_STOP=1`).
- A rejected MongoDB API or Redis command exits without contacting the store and
  explains that `--write` is required.
- The MongoDB check is conservative pattern matching, not a database
  authorization boundary. Production access remains outside this helper.

## Tests and verification

Run `pnpm db:query --help`, then one harmless read against each running store.
Formatting and documentation links are covered by `pnpm format:check` and
`pnpm docs:check`.
