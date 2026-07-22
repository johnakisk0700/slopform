# Backend agent contract

The repository `AGENTS.md` applies here. Read `docs/backend.md`, the relevant
page under `docs/backend/mechanisms/`, and the owning module document before
changing backend behavior.

## Documentation routing

- Cross-cutting runtime behavior such as queues, authentication, audit,
  observability or provider delivery belongs in `docs/backend/mechanisms/`.
- Product-domain boundaries and non-trivial lifecycles belong in
  `docs/backend/modules/`.
- Schema ownership and migration consequences stay explicit in the relevant
  module/mechanism page and, when architectural, an ADR.

Update diagrams, invariants, failure behavior, configuration, job/API contracts
and operational checks with the code. A new environment variable without docs,
or a new retry path absent from the mechanism flow, is an incomplete change.

Controllers own transport, services own use-case ordering/invariants,
repositories own explicit persistence and infrastructure adapters own providers.
Do not create a documentation page for every class; document stable boundaries
that another agent must understand to extend the system safely.
