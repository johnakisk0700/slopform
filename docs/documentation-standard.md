# Documentation standard

Structure for a reusable component or mechanism. Drop irrelevant sections;
do not fill them with ceremony.

## Required content

1. **Purpose and boundary** — what this owns and does not.
2. **Contract** — inputs, outputs, states, events or persisted effects.
3. **Flow** — compact Mermaid when three or more actors/states are involved.
4. **Invariants** — rules that must hold during extension.
5. **Failure states** — retries, loading, empty, degraded, recovery.
6. **Extension points** — supported way to add a case without bypassing the boundary.
7. **Operations and tests** — config, logs/metrics, focused checks.
8. **Decisions and references** — ADRs, source files, official docs.

## Mermaid rules

- Prefer `flowchart` for ownership/topology; `sequenceDiagram` for dialogue.
- Show domain actors and state changes, not every function call.
- Plain-language labels; keep diagrams near the prose they support.
- Update the diagram when the flow changes.

## Library-specific guidance

State the verified package version and date; link primary docs. Call out license
or compatibility constraints that affected the choice. Do not copy external
manuals into the repo — stale duplication is misinformation.
