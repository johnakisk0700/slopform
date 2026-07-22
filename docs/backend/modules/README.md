# Backend module inventory

Product-domain modules with their own lifecycle, invariants or permissions get a
focused page in this directory. Use
[`../../documentation-standard.md`](../../documentation-standard.md) and link
the owning source module.

No product-domain module has been implemented yet. The current
`apps/backend/src/modules/reference/` module is a disposable executable pattern
and must not quietly evolve into production CRUD. The first real vertical slice
should add its module page here and then remove the reference module through a
reviewed forward migration.

Cross-cutting infrastructure belongs in
[`../mechanisms/README.md`](../mechanisms/README.md), not in this inventory.
