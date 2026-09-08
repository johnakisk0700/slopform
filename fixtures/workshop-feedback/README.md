# Synthetic workshop feedback corpus

Fictional smartphone-photography workshop with 100 participant profiles. The
event brief and profiles were authored by native Codex Astra agents; the dialogue
batches by native Codex Luna agents at xhigh. See
[the scenario plan](../../docs/showcase-scenarios.md).

The corpus contains 395 messages across 55 complete, 30 partial, five declined
and ten silent scenarios. Silent scenarios contain only the bot invitation.

## Read and regenerate

1. [Event brief](event-brief.md): what happened and who could know about it.
2. [Participant profiles](participant-profiles.json): 55 reusable archetypes,
   100 individually assigned experiences and response outcomes.
3. [Generation prompt](generation-prompt.md): interview and JSON authoring rules.
4. `batches/`: ten Luna-authored files, ten participants each; batch 01 is the
   pilot reviewed before generating the remaining batches.
5. `generated/`: deterministic projection of the accepted batch files.

[Authoring review](review.md) records pilot corrections and the limits of the
checks performed.

For a quick read, start with `p003` in batch 01 (a corrected score on a different
scale), `p044` in batch 05 (left before later sessions), `p065` in batch 07
(quoted STOP), and `p085` in batch 09 (two separate complaints). Each conversation
keeps its dialogue and draft evidence expectations together in the source batch.

```sh
pnpm workshop:build-fixtures
pnpm test:workshop-scenarios
```

Both commands build the backend dependency through Turbo. The first writes JSON
files; the second verifies that committed files match the inputs. No provider or
database is contacted. Fixture checks also run inside `pnpm check`.

`generated/pg-messages.json` contains deterministic participant/conversation IDs
and the actual PostgreSQL stored-message shape: `id`, `seq`, `actor`, `text`,
`providerMessageId`, `ingressId`, `outboxId`, `attention`, `at`. Every projected
message is checked with the existing backend Zod schema. These synthetic ingress
and outbox IDs are proposed fixture identifiers, not real delivery evidence.

`generated/expected-findings.json` contains separate draft expected findings and
participant source-message IDs. It is never part of extractor input or a source
of pre-seeded notes. Corrections retain their local source sequence numbers.
`generated/manifest.json` records source hashes, generator settings and totals.

## What this corpus proves

The checks prove participant coverage, structure, message/evidence references,
chronology, silence invariants and compatibility of message serialization.
Authoring review checks plausibility and specific edge cases. Neither proves
that extraction or clustering passed: actual provider-backed replay and a
semantic evaluation remain separate work. Expected findings remain marked draft
until that evaluation; agent-written expectations are not a ground-truth oracle.

## Runtime import boundary

This is a **seed source**, not a runnable campaign database dump. The proposed
workshop interview differs from the current V2 table/meet-again questionnaire.
`runtimeImportReady: false` is deliberate. No questionnaire version, lifecycle,
accepted answers, notes, delivery success or completed analysis is fabricated.

A future seed/replay adapter must implement the approved workshop questionnaire,
create real matching campaign/participant/provenance records in an isolated
simulated environment, and pass these messages through extraction. Reusing the
legacy Mongo-to-PostgreSQL importer would bypass that contract and is incorrect.
Do not insert these JSON objects directly into a production conversation row.

Participant outcome `complete` means a finished authored feedback exchange; it
does not mean all current V2 goals were answered. Partial/declined/silent outcomes
remain visible. Event-level themes are authoring coverage, never labels supplied
to the clustering model. All people, experience details and text are synthetic.
