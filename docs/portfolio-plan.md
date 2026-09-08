# Portfolio / Slopform plan

Last updated: **2026-09-08**. This is the current product-planning map, not a
claim that the proposed public demo exists. The campaign topic-analysis backend
slice below is implemented; the other demo tasks remain planning work.

[Notion Portfolio](https://app.notion.com/p/3d45e2e6ab7e8165b51fc1164cb09c44) ·
[Slopform project](https://app.notion.com/p/3d45e2e6ab7e81338422ec29fa6a7c13) ·
[Task board](https://app.notion.com/p/bf28dd081b94459ca9ef871895b258f0?v=3d45e2e6ab7e81e0b463000c3fca9d77) ·
[Code naming and readability](code-readability.md)

## Purpose and current checkpoint

Build a fullstack portfolio product with an understandable event/workshop
feedback showcase and code the user can explain in a technical interview. Keep the
research Assistant central to the experience. Work in bounded slices rather
than reopening the whole mechanism on each turn.

Implementation baseline: **`191c70a`**, following `7f55117`. The core incoming
message → AI → outbound-send flow is ready for a first guided reading. The
whole feedback module is not finished, and the visitor demo is not implemented.

See the [refactor status](backend/modules/post-event-feedback-refactor-status.md)
for completed work, dated line counts and verification. Start reading through
the [HTML guide](backend/modules/post-event-feedback-reading.html): six actual
methods, 355 lines at the checkpoint, and four scenario walks.

## Already implemented; do not reopen without a concrete reason

- Campaign feedback conversations live in PostgreSQL. Assistant conversation
  threads remain in MongoDB. The old campaign conversation cross-store sync
  has been removed.
- The core extraction, ingress routing and outbound dispatcher have distinct
  operation owners. Runtime stage logs observe; immutable outbound evidence
  controls dispatch eligibility. A WhatsApp adapter, polling sender and durable
  work/wake-ups already exist.
- Effect utilities compose local flows without Tags, Context or Layers.
  Transactions remain service-owned and explicit inside the operation.
- The HTML reading guide and deferred `vibes/` test location already exist.
  Those tests remain active. The roughly 4,500-line extract file is a test
  suite, not the production extractor entry.
- Clerk currently admits allowlisted operators. Assistant threads are owned
  by users, but business data accessed by the tools remains shared. This is
  not yet visitor sandbox isolation.
- The sibling `bento-portfolio` contains a browser voice loop with speech
  recognition, AI, speech synthesis and interruption handling. It does not yet
  provide the Slopform interview/results integration or outbound telephone
  dialing. Its existing calendar tools are demo stubs.

## Agreed preferences and demo direction

| Topic            | What to carry forward                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naming           | Calls reveal their action and object. `demoSandbox.ensureDataForUser(user.id)` is the accepted example. `ensure` is allowed; omitting `Data` hid what the operation ensured.                                                                         |
| Readable flows   | Use recognizable stages, concrete repositories and coherent functions/classes. Add short purpose comments. Examples such as extract, STOP or profanity do not become automatic workstreams.                                                          |
| Research chat    | Remains a first-class product surface. Current research uses internal read-only tools, not web search or mutation tools.                                                                                                                             |
| Login            | Google login for personal live demo access. Existing admin admission must not automatically grant visitors the operator role.                                                                                                                        |
| Chat allowance   | Direction: two or three live messages per account. The exact count is still open.                                                                                                                                                                    |
| Voice            | Prefer live browser interaction, with a target of two minutes per account (90–120 seconds discussed). The visitor plays the interviewee. Telephone integration is a later extension.                                                                 |
| Cost             | The user accepts a small prepaid demo budget, roughly ten euros. Approximately USD 0.10 per two-minute session is the user's estimate, not a verified all-provider billing cap. Use proportionate server limits and a usable exhausted-credit state. |
| Data             | Each visitor starts from the same curated fictional dataset; their mutations belong to their own sandbox.                                                                                                                                            |
| Seeder direction | Shared PostgreSQL schema with ownership and a user-scoped initializer, rather than one schema/database clone per visitor. The exact ownership columns and constraints still need a concrete design.                                                  |
| Initialization   | `ensureDataForUser(user.id)` uses verified identity on first demo entry. Preserve existing data; create the PostgreSQL seed atomically and once under concurrent/repeated calls. Reset must not refresh usage allowances.                            |
| Agents           | GPT/Astra through native Codex, Grok through Cursor when delegation is authorized. Root reads critical code and integrates. No silent GPT routing through Cursor.                                                                                    |

These are product directions and working preferences. They do not supersede
the current private-admin runtime contract. Visitor admission, ownership,
schema and API changes need their own documented implementation slice and any
required new ADR; do not edit accepted historical ADRs to imply they already
permit a public demo.

## Campaign topic analysis: backend implementation

The first showcase is feedback after events/workshops, including research over
many responses. The user selected a **workshop with 100 participants** as the
first concrete showcase. The working subject is smartphone photography; the
[showcase and scenario plan](showcase-scenarios.md) records the story, remaining
questionnaire gap and the next `Create test scenarios` task.
A second showcase is optional; SaaS onboarding is not selected.
Do not claim response rates or participant motivation have been validated.

The bounded asynchronous backend analyzes existing campaign feedback. See
[campaign topic analysis](backend/modules/campaign-topic-analysis.md) for the
implemented flow, research sources, limits and failure behavior. It adds no
visitor UI or Assistant tool yet.

The implementation follows these boundaries:

- Keep the current live extraction and conversation behavior. Do not redesign
  the campaign questionnaire or move extraction in this slice.
- Node owns authenticated requests, jobs, run state, immutable input snapshots,
  OpenRouter calls, repositories and PostgreSQL transactions/results.
- Use OpenRouter for embeddings; store reusable vectors with the input and
  model/config identity. No local embedding model is required.
- The initial choice is Qwen3 Embedding 8B through OpenRouter, 1,024 dimensions,
  with a USD 0.01/million input-token provider price ceiling. PostgreSQL `real[]`
  stores cached vectors; no similarity index or separate vector database is
  needed for bounded batch clustering. Greek/Greeklish semantic quality still
  needs representative feedback; multilingual support alone does not prove it.
- A Python subprocess runs BERTopic on supplied text and vectors. Node owns
  its lifetime through a small infrastructure adapter with Effect composition,
  timeout/cancellation, bounded IO and a versioned structured protocol.
  Python receives no database credentials and does not write PostgreSQL.
- Persist successful stages and final results. Concurrent requests, retries,
  stale workers and restart recovery must not duplicate or overwrite a newer
  completed result. Do not promise exactly-once external billing across crashes.
- Keep progress separate from logs. Expose status and completed results through
  the backend; UI polish and research-chat tool extensions are separate work.
- Bound input size, provider requests and subprocess concurrency for a small
  VPS. Numeric resource estimates from discussion are not measured guarantees.

BERTopic is the selected library for this slice, not proof of clustering
quality on Greek/Greeklish. Translation, additional LLM normalization, automatic
taxonomy evolution and large comparative experiments are not prerequisites.

## Still open

- **Campaign analysis product rewrite.** Replace the six-person, gossip-oriented
  summary experience with a standalone analysis view using themes, distinct
  respondent counts, evidence and research chat. The topic backend is complete;
  questionnaire adaptation, summary replacement and UI/tool integration are not.

- **Second showcase.** Event/workshop feedback is selected first. Another
  business case needs a concrete user benefit; the previous candidate list is
  brainstorming, not validated demand or an instruction to generalize events.
- **Recording.** Transcript, structured results and full audio are possible
  product choices. The user deliberately deferred that decision.
- **Isolation details.** Seeder creation alone is not isolation. Ownership
  must reach reads, writes, AI tools and background work, and the selected
  design must account for existing global email/phone uniqueness and FKs.
- **Runtime allowances.** Choose the exact chat count and confirm which
  provider limits cover the demo. Keep the work proportional to a small
  portfolio audience and the accepted budget.

## Tasks

Notion owns live task status. This table records task scope, not a duplicate
completion tracker or a separate priority system.

| Task                                              | Deliverable                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01. Define the event/workshop showcase            | A concrete demo story and explicit current-versus-new capability gaps; a second business case is optional.                                                                       |
| 02. Read the core message flow                    | Walk ordinary, STOP, superseded and uncertain delivery; explain each mechanism and record only concrete remaining reading problems.                                              |
| 03. Define demo ownership and admission           | A bounded contract for visitor identity, owned data, constraints, scoped tools/jobs and initialization.                                                                          |
| 04. Implement the selected sandbox isolation      | Enforced ownership across the selected demo flow, with cross-user reads/writes and references checked. Split implementation only after task 03 identifies its actual boundaries. |
| 05. Seed a user's demo data once                  | Curated records and generated UUID relationships, one atomic PostgreSQL initialization, repeat/concurrency behavior and no paid provider side effects.                           |
| 06. Expose the personal text demo                 | Visitor Google login, selected chat allowance, private sandbox and clear exhausted-credit behavior.                                                                              |
| 07. Connect the two-minute browser voice demo     | One selected interview story, bounded session, visible captured result and measured representative provider usage.                                                               |
| 08. Clarify staff actions                         | Readable takeover/resume/close, staff messages and correction entry flows with preserved behavior.                                                                               |
| 09. Replace the legacy campaign summary           | Standalone campaign analysis with evidence, respondent counts and research-chat access; replace the six-person/gossip framing.                                                   |
| 10. Review large repositories and delivery detail | Concrete responsibility findings; retain cohesive SQL owners and already clear dispatcher boundaries.                                                                            |
| 11. Review deferred tests and harnesses           | Behavior-checked cases/fixtures, duplication removed and reviewed suites returned to their owners while coverage remains active.                                                 |
| 12. Rehearse the showcase and interview           | Repeatable demo plus explanations of storage, queues, failure handling and human correction; fix material findings before handoff.                                               |
| 13. Implement campaign topic-analysis backend     | Completed at `bfed7c4`: Node orchestration, OpenRouter embeddings, Python clustering and PostgreSQL persistence; live provider/container verification remains open.              |
| 14. Create test scenarios                         | Approved workshop questionnaire/pilot, bounded Luna batches, frozen synthetic conversations, reviewed expected findings and repeatable extraction replay; see the scenario plan. |

Real telephone dialing, a general phone-plus-arbitrary-goal builder, venue
quote collection and web search remain future ideas outside this first task
batch. Raw-audio storage is undecided, not rejected.

## How we maintain this plan

Use plain Notion pages for the navigation hierarchy: **Portfolio → Slopform**.
The task database lives inside Slopform. Do not make Portfolio a projects
database: its sidebar children become views instead of the project pages the
user expects. The initial database wrapper was replaced with this page
hierarchy; the existing Slopform page and all twelve task IDs were preserved.

The user wants a simple Trello-style board: **To do → In progress → Done**,
with descriptions and comments inside each card. Keep only the task title and
status; do not add Now/Next/Later buckets, area fields or filtered planning
views. The current native Notion status calls To do **Not started**. The board
link above opens the status board directly.

New tasks start in To do; move them to In progress when work actually starts
and Done when complete. Each task has a concrete outcome and completion
criteria. Record the implementation checkpoint, relevant verification and
unresolved findings when it completes. Do not turn each conversation example
into another task.

Notion holds the working queue. Repository docs hold naming conventions,
architecture, operational contracts and dated implementation evidence. Update
both at the end of the relevant checkpoint; there is no automatic sync.

The older Notion
[Join The Six MVP Scope & Estimates](https://app.notion.com/p/38b5e2e6ab7e81c6aa5ec662ffd9492c)
is historical context. Its old estimates and outstanding items are not the
current Slopform backlog.
