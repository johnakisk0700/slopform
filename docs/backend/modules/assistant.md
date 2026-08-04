# Durable assistant threads

Status: implemented asynchronous generation, live text/reasoning/tool SSE,
durable turn artifacts and a read-only tool set. Last verified: **2026-08-05**
against AI SDK `7.0.35`,
`@ai-sdk/openai` `4.0.18` and `@openrouter/ai-sdk-provider` `3.0.0`.

## Purpose and boundary

Owner-scoped conversation threads and ordered turns live in MongoDB. Each model
generation runs on the BullMQ worker; the HTTP process never calls a provider.
PostgreSQL holds request-id idempotency, attempt fencing, recovery and queue
execution — delivery authority, not the conversation-content read store. The
worker reloads history from MongoDB; Redis carries identifiers and the
best-effort live relay only.

Product mutations are out of scope: nine read-only tools, no writes. Live text
is an accelerator; the persisted turn is the answer — see
[assistant streaming](../mechanisms/assistant-streaming.md). Admin UI, polling
and card parsing live in
[the assistant screen](../../frontend/assistant.md).

## Models and provider adapters

| Public model id           | Provider   | Provider model id         |
| ------------------------- | ---------- | ------------------------- |
| `openai/gpt-5.6-luna`     | OpenAI     | `gpt-5.6-luna`            |
| `openai/gpt-5.6-terra`    | OpenAI     | `gpt-5.6-terra`           |
| `google/gemini-3.6-flash` | OpenRouter | `google/gemini-3.6-flash` |
| `qwen/qwen3.7-max`        | OpenRouter | `qwen/qwen3.7-max`        |

Mapping lives in `assistant-models.ts` with an exact contract test. Default is
`google/gemini-3.6-flash`. OpenRouter needs `vendor/model`; OpenAI wants the
bare name — either mistake is a 404. The adapter is part of the persisted
contract: `openai/gpt-5.6-luna` always means direct OpenAI. Missing credentials
fail closed; they never substitute another provider or model. A possible
OpenRouter Luna Pro fallback needs its own public id.

Post-event feedback extraction reuses this registry through
`FEEDBACK_EXTRACTION_MODEL` (one public-id → provider-id table; not the
assistant default constant). Missing provider configuration returns `503`.
Provider clients are created once per worker service.

Every turn persists reasoning effort `low` | `medium` | `high` (default `low`)
and service tier `standard` | `fast` (default `standard`). The worker maps
effort to `{ openai: { reasoningEffort } }` or
`{ openrouter: { reasoning: { effort } } }` from the adapter. Fast tier is an
OpenAI parameter (`serviceTier: "priority"` in `@ai-sdk/openai@4.0.18`);
OpenRouter models normalise to `standard` before persist and omit the field.
Retry/resume reuse persisted model, effort and tier — never re-infer.

## HTTP contract

Clerk authentication; ownership from the verified subject only.

| Operation | Route | Notes |
| --------- | ----- | ----- |
| Create | `POST /api/v1/assistant/threads` | Body `{ requestId, model?, effort?, serviceTier?, content }` → full thread |
| List | `GET /api/v1/assistant/threads` | 50 most recently updated owned summaries |
| Read | `GET /api/v1/assistant/threads/:id` | Owned thread, ordered turns |
| Append | `POST /api/v1/assistant/threads/:id/turns` | Same body → new turn |
| Branch | `POST /api/v1/assistant/threads/:id/branches` | Same body + `sourceTurnId` → new thread with immutable prefix |
| Poll | `GET …/turns/:turnId` | Authoritative turn state |
| Stream | `GET …/turns/:turnId/stream` | Authenticated best-effort SSE; polling remains authoritative |
| Retry | `POST …/turns/:turnId/retry` | Latest failed turn only; same id, next attempt |

`requestId` is a client UUID, unique per owner. Identical replay of
owner/UUID/operation/model/effort/serviceTier/content returns the existing
record. Tier is part of that tuple (it doubles the bill). Nonterminal replay
reasserts the same deterministic queue job id. Replay is resolved before
provider availability checks. Different input/operation → `409`. Lock and
uniqueness scope: `(owner, requestId)`.

Branching is idempotent on the same owner/request id and records source
thread/turn lineage. Different source → conflict. Mongo stores the copied
prefix so a missing branch aggregate can be reconstructed without re-executing
inherited answers.

Turn view: `id`, `requestId`, `sequence`, `status`, `model`, `effort`,
`serviceTier`, `user`, nullable `assistant` / `partial` / `reasoning`, bounded
`toolCalls`, nullable final `usage`, nullable safe `error`, `attempt`,
timestamps. `partial` is nonterminal only and cleared on settle. Reasoning and
tool calls belong to the attempt (inspectable after success/failure); usage
only after successful completion. Statuses: `queued`, `running`, `succeeded`,
`failed`. Failure codes: `provider_unavailable`, `provider_rejected`,
`generation_failed`. Unknown and other-owner ids → `404`.

## Flow and persistence

```mermaid
sequenceDiagram
  participant Admin as Authenticated admin
  participant API as Nest HTTP
  participant Mongo as MongoDB
  participant DB as PostgreSQL execution
  participant Queue as BullMQ
  participant Redis as Redis stream relay
  participant Worker as Nest worker
  participant Model as OpenRouter or OpenAI

  Admin->>API: POST content + model + effort + requestId
  API->>DB: Fence idempotency; allocate attempt/order
  API->>Mongo: Materialize owned queued turn
  API->>Queue: Enqueue turn id
  API-->>Admin: Durable thread/turn
  Queue->>Worker: assistant.generate-turn.v2
  Worker->>DB: Fence execution attempt
  Worker->>Mongo: Load succeeded history
  Worker->>Model: streamText with read-only tools
  Model-->>Worker: Text/reasoning deltas, tool calls
  Worker->>Redis: Publish coalesced accumulated frames
  Redis-->>API: Replay/follow attempt stream
  API-->>Admin: Authenticated SSE frames
  Worker->>Mongo: Throttled partial snapshot; then terminal result
  Worker->>DB: Advance delivery projection
  Admin->>API: Poll turn / reload thread
  API-->>Admin: Current durable state
```

Live frame coalescing, Redis key shape and poll/SSE stage invariants:
[assistant streaming](../mechanisms/assistant-streaming.md).

MongoDB `conversation_threads` is authoritative for title, ordered user input,
assistant output/error and user-visible lifecycle (purpose, channel, owner,
future goal/takeover, ≤75 embedded turns). Owner filters on every public
lookup/update. Status transitions compare exact turn attempt. An
edit-in-new-conversation branch copies source turns before the selected user
turn (original ids, artifacts, timestamps), records lineage, then adds one new
queued turn at that sequence. Branches of branches follow the visible
aggregate.

PostgreSQL `assistant_threads` / `assistant_turns`: owner-bound request id,
sequence, model, effort, `service_tier`, attempt, queue recovery,
`streamed_content`, durable `reasoning_content`, bounded `tool_calls` JSON,
token/cost columns. Only `streamed_content` is confined to `queued`/`running`.
Legacy `user_content` / `assistant_content` are compatibility/backfill only —
not read for API or model history after Mongo materialization. Partial unique
index: one queued/running attempt per thread; advisory locks serialize append
and retry. First branch turn stores nullable
`branched_from_thread_id` / `branched_from_turn_id` (thread FK only — the
referenced turn may be an inherited Mongo member).

Model history is succeeded Mongo user/assistant pairs plus current user
content. Failed/incomplete prior work and tool call/results are not
round-tripped; a later turn re-calls tools for freshness. Thread-list reads
project compact metadata only.

## Retry, recovery and failure

- BullMQ payload: schema version, turn id, correlation id only.
- Job id includes durable turn attempt; worker compares to PostgreSQL before
  generation.
- Transient BullMQ retries reuse the attempt; retrying a terminal failed turn
  increments attempt and uses a new job id.
- Terminal writes require matching attempt and nonterminal status. Mongo first;
  worker start repairs lagging PostgreSQL. Competing terminal for the same
  attempt → reload Mongo and repair PG.
- Oversized provider output → permanent safe `generation_failed`.
- Stall can still repeat a provider call (no false exactly-once).
- Rejection/config errors stop retrying; timeouts, rate limits and provider 5xx
  use BullMQ retry.
- Queue insert failure marks that attempt failed and returns `503`; replay
  returns the same failed turn.
- Terminal BullMQ `failed` event reconciles even outside the processor
  `try/catch`; already-terminal rows are not overwritten.
- Recovery on startup and every five minutes: ≤100 queued/running turns older
  than 15 minutes (beyond five complete two-minute attempts). Preserve while
  the exact attempt job is waiting/delayed/prioritized/active/waiting-children;
  otherwise materialize missing Mongo then fail through the same guard.

Create/append: PostgreSQL first, then Mongo, then enqueue. Mongo gap on replay
materializes and enqueues — not silent completed idempotency. Retry increments
the latest PG failed attempt before Mongo. Append capacity is re-checked under
the thread lock. No cross-store transaction; the PG-to-queue crash gap remains
(transactional outbox in [queues](../mechanisms/queues.md) if delivery becomes
critical).

## Tools

Nine read-only tools on every model that can accept them:
`current_datetime`, `list_events`, `get_event`, `search_participants`,
`get_participant`, `list_feedback_campaigns`, `get_campaign_summary`,
`list_feedback_conversations`, `get_feedback_conversation`.

Bounds: `ASSISTANT_MAX_STEPS` 10 (`prepareStep` forces `toolChoice: "none"` on
the penultimate step); ≤`TOOL_RESULT_MAX_ROWS` (25) with
`{ rows, total, truncated }`; conversation reads take the last 25 turns; misses
return `{ found: false }`. OpenRouter tool requests carry
`provider: { require_parameters: true }`. Capability is per-adapter
`supportsTools`.

Tool activity is an accumulated typed list keyed by provider tool-call id,
published live, written under `(turnId, attempt)`, retained at settlement.
Caps: 512 serialized input chars, 1,536 result chars, ≤20 calls. Provider
errors are not stored. Artifacts are excluded from future model history.

### Cards and charts (prompt contract)

The system prompt asks for fenced ` ```jts ` / ` ```chart ` blocks. The admin
parses and renders them — see
[assistant screen](../../frontend/assistant.md#rendering-contract). Changing
the card/chart contract means changing the prompt and the admin parser
together. Campaign summaries reuse the same chart fence —
[Campaign summary](post-event-feedback.md#campaign-summary).

## Service tier, usage and cost

Persisted `service_tier` is what the turn ran under (retry reuses it). Fast is
exactly 2× standard on OpenAI short-context list rates; OpenRouter models
cannot buy it. Adapter translates public `fast` → SDK `priority`.

Successful turns persist SDK token breakdown and estimated EUR cost (integer
euro-micros, pricing version `2026-08-03` in `assistant-pricing.ts`). Cached
input is priced separately where a stable rate exists; reasoning tokens are
part of provider-reported output. FX is a pinned dated constant — not a live
ECB fetch. Operator aid, not billing: cache writes, regional uplift and
long-context surge are not reconstructed as an invoice.

## Future mutations

Do not place tool state in `assistant_turns.assistant_content`. When mutations
arrive: keep read-only tool records observational; add proposed-action records
with typed payload, pending status, identities and expiry; confirm via a
separate authenticated endpoint that revalidates auth and DB state, then
mutates and audits in one transaction; rebuild model history from deterministic
summaries. The worker may propose; it must never execute a product write from
model text or a tool call alone.

## Configuration, observability and tests

`OPENROUTER_API_KEY` → Gemini / Qwen; `OPENAI_API_KEY` → Luna / Terra. Two-minute
total bound; AI SDK retries disabled (BullMQ owns retries). Worker concurrency
two per process; every provider call also takes a deployment-wide Redis lease
capped at `PROVIDER_CALL_CONCURRENCY_LIMIT` (30), shared with feedback
extraction, attention classification and campaign summaries, plus 30 starts per
rolling minute.

Logs: queue/job/turn correlation and safe error categories — never prompts,
answers, keys or provider bodies. Focused tests cover Mongo contracts,
attempt CAS, conflicting terminals, cross-store replay, non-latest retry,
history reconstruction, adapters, HTTP/OpenAPI, composition, terminal-event
reconciliation, stale recovery and PG constraints. Clean PG migration
verification runs twice.

Original assistant-run and durable-thread migrations ship together; durable
migration drops empty `assistant_runs` only (fails closed if non-empty).
`20260723025013_allow_qwen_3_7_max_assistant_turns.sql` recreates
`assistant_turns_model_check` with the four current IDs. No automatic retention;
embedded threads stop at 75 turns (MongoDB 16 MiB BSON).

## Sources and official references

- [Module source](../../../apps/backend/src/modules/assistant/),
  [conversation aggregate](conversations.md),
  [database projection](../../../packages/database/src/schema/assistant.ts),
  [MongoDB lifecycle](../mechanisms/mongodb.md),
  [queue mechanism](../mechanisms/queues.md),
  [assistant streaming](../mechanisms/assistant-streaming.md),
  [assistant screen](../../frontend/assistant.md)
- [AI SDK `generateText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text),
  [model messages](https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message),
  [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai),
  [OpenRouter provider](https://github.com/OpenRouterTeam/ai-sdk-provider)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
  [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
  [Gemini 3.6 Flash](https://openrouter.ai/google/gemini-3.6-flash),
  [Qwen3.7 Max](https://openrouter.ai/qwen/qwen3.7-max)
