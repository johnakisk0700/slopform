# Documentation standard

Use this structure for a reusable component or mechanism. Remove irrelevant
sections instead of filling them with ceremony.

## Required content

1. **Purpose and boundary** — what this owns and deliberately does not own.
2. **Contract** — inputs, outputs, states, events or persisted effects.
3. **Flow** — a compact Mermaid diagram when three or more actors/states are
   involved.
4. **Invariants** — rules that must remain true during extension.
5. **Failure states** — retries, loading, empty, degraded and recovery behavior.
6. **Extension points** — the supported way to add a case without bypassing the
   boundary.
7. **Operations and tests** — configuration, logs/metrics and focused checks.
8. **Decisions and references** — linked ADRs, source files and official docs.

## Mermaid rules

- Prefer `flowchart` for ownership/topology and `sequenceDiagram` for dialogue.
- Show domain actors and state changes, not every function call.
- Keep labels in plain language and diagrams near the prose they support.
- Update the diagram whenever its described flow changes.

## Library-specific guidance

State the verified package version and date. Link primary documentation. If a
license or compatibility constraint affects the choice, say so explicitly.
Avoid copying entire external manuals into this repository; stale duplication is
just misinformation with nicer formatting.
