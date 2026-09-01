# ADR 0014: Public Slopform identity and remaining compatibility IDs

- Status: Accepted
- Date: 2026-09-01
- Scope: Public product name, portfolio publication, example deployment
  hosts, and which Join The Six identifiers this tree deliberately keeps.
  Does not rewrite accepted ADRs 0001–0013, `docs/history/`, dated evidence,
  guest fixtures, question sets, or participant-facing policy copy.

## Decision

The public name of this repository and operator system is **Slopform**. The
locked product line is:

> The form is texting you now.

Describe the system as it actually is: operators configure a research campaign
and questions; AI-guided WhatsApp conversations collect answers; an admin
surface manages delivery, transcripts, review, outbox state, retries,
idempotency, queues and summaries.

This tree is a **portfolio source publication of a private operator system**.
It is not a public SaaS, does not claim users or traction, and must not be
documented as if the author's current private host were a public production
service.

Committed production examples use only:

- hostname `slopform.example.com`
- RFC 5737 documentation addresses (for example `203.0.113.10`)
- install root `/opt/slopform`

Coupled confirmation literals, runbooks and script tests stay in lockstep with
those examples.

Supersedes the public naming and example-host consequences of earlier Join The
Six operator docs. Does **not** supersede the ownership, persistence or
orchestration decisions in ADRs 0001–0013.

## Why

Publishing the operator stack under the original product name would imply the
repository is Join The Six's public product, that a live customer site is
included, or that documented VPS/DNS values are a public production service.
They are not. The conversation loop is the system; the historical dinner-club
admin is why events, participants and WordPress import still exist.

Old accepted ADRs stay as written so the decision record remains a record.
Rewriting them as if the work had always been called Slopform would erase
provenance.

## What changed in the public tree

- README, living handbooks and operator CLI help use Slopform. Workspace
  packages in this tree are `slopform` / `@slopform/*`.
- Deploy docs, nginx examples and production scripts use the example hosts
  above. Domain confirmation tokens
  (`CONFIRM_PRODUCTION_DATA_PUSH`, `CONFIRM_SEAL_DATA_IMPORT_WINDOW`) match
  `slopform.example.com`.
- Private evidence records that cannot be published were removed; the evidence
  index lists only what remains.
- The live WordPress WP-CLI export recipe is not in this tree. Import still
  accepts operator-produced WXR or the fake JSON envelope under
  `scripts/wordpress/`.
- `report/`, `tmp/` and recovered WordPress/source dumps are gitignored so they
  cannot be committed again.

## Legacy compatibility IDs (deliberately unchanged)

These remain Join The Six-era identifiers because they are runtime, schema,
lock, fixture or historical contracts. Do not globally search-replace them as
part of the public rename:

| Kind                                         | Examples                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database and Mongo names                     | `join_the_six`, `join_the_six_root`                                                                                                                    |
| Docker image, Compose project and OCI labels | `join-the-six-web`, `join-the-six-api`, `join-the-six-worker`, `join-the-six-migrate`, `join-the-six-dev`, `org.join-the-six.web-public-config-sha256` |
| Host lock / seal / backup paths              | `/var/lock/join-the-six-production.lock`, `/var/lib/join-the-six/data-import-window.sealed`, `/var/backups/join-the-six`                               |
| Data-push quiescence token                   | `I_HAVE_STOPPED_ALL_JOIN_THE_SIX_LOCAL_WRITERS`                                                                                                        |
| Observability                                | `OTEL_SERVICE_NAME=join-the-six` (and the local `-api` / `-worker` suffixes)                                                                           |
| Redis / CSS / localStorage                   | `jts:*` keys, `--jts-*` tokens, `jts-theme`, `jts-palette`                                                                                             |
| UI and type prefixes                         | `Jts*` components and types                                                                                                                            |
| Default house theme                          | operator label **Slopform**; palette id remains `join-the-six`                                                                                         |
| API paths, operation IDs, question keys      | `/api/v1/...`, OpenAPI `operationId`s, feedback question-set keys                                                                                      |
| Burst fixture identities                     | `burst.*@burst.jointhesix.local`                                                                                                                       |
| Product-policy fixtures                      | approved Greek policy answers that name Join The Six                                                                                                   |
| Historical records                           | ADRs 0001–0013, `docs/history/`, remaining dated evidence, guest names                                                                                 |

Workspace package names are now `slopform` / `@slopform/*`. Docker image names,
database names and the rows above stay Join The Six-era compatibility IDs
because changing them would break running volumes, locks and deploys.

Do not silently rewrite the schema, lock, API, token or fixture rows above
without an explicit compatibility plan.

## Rejected

- Pretending this repository is a public marketing site or multi-tenant SaaS.
- Rewriting accepted ADRs, history files or policy fixtures to say Slopform.
- Publishing real VPS addresses, registrar zones, Clerk tenant hostnames or
  WordPress dump recipes as if they were documentation examples.
- Selecting a software license in this change. License remains an explicit
  owner release decision.

## Consequences

- Living docs describe Slopform and point here when they mention leftover
  Join The Six identifiers.
- `pnpm prod` help, nginx examples and data-push confirmations agree on
  `slopform.example.com` / `203.0.113.10` / `/opt/slopform`.
- Readers of ADR 0004 still see Join The Six: that was the ownership decision
  at the time. Today's public identity is this ADR.
