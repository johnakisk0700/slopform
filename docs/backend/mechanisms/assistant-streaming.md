# Assistant streaming — durable turns with a live accelerator

Status: stages A and B landed, including durable reasoning, tool traces, priced
usage and stable answer layout.
Last verified: **2026-08-03**. This is the canonical design for putting live
assistant text on `/admin/assistant` without giving up the durable turn.

## Why this is not a one-line port

The screen's chat composition was ported from `notes_ai`, but only half of that
project's answer model came with it. `notes_ai` runs `streamText` inside the HTTP
request and treats the persisted thread as the source of truth with the live SSE
stream as a _best-effort accelerator_ — its own `docs/chat-durability-plan.md`
says so, and the reason is flaky mobile connections. Join The Six kept the
durable half (queued turn, BullMQ worker, idempotent replay, attempt fencing,
retry) and at first dropped the accelerator entirely, so nothing reached the
operator until the whole answer landed. Stage A put the accelerator back on the
existing poll rather than on a new transport; stage B is what replaces the
channel.

Three local constraints rule out copying the source's shape verbatim:

1. **Generation does not run in the request.** `dev:http` and `dev:worker` are
   separate processes. Tokens produced in the worker can only reach an HTTP
   response through a broker; Redis is already a hard dependency of the queue.
2. **A turn lives in two stores.** `assistant_turns` in PostgreSQL is the
   execution projection that owns fencing; the MongoDB `conversation_threads`
   document is the read model `toThreadView` serves. Partial text reaches both under
   the same attempt fence, or a reload could show text from a superseded attempt.
3. **The schema forbids nonterminal content.** `assistant_turns_result_check`
   asserts `assistant_content` is null unless the turn succeeded. That check is
   load-bearing — it is what makes "succeeded content is authoritative" true — so
   partial text gets its own column instead of relaxing it.

## Invariants

- The persisted turn stays the source of truth. A stream is an accelerator and
  the UI must be correct with it entirely absent.
- Partial text is fenced by `(turnId, attempt)`. A write from a superseded
  attempt is dropped, never applied.
- Partial text is never promoted to the answer. Terminal content comes only from
  `markSucceeded`; a turn that dies mid-stream is `failed`, not a short success.
- Partial text is cleared when the turn reaches a terminal state, so no reader
  can mistake it for a result.
- Retry semantics are unchanged: a retried turn increments `attempt` and its
  earlier partial text is discarded.

## Stage A — partial text over the existing poll — landed

The worker streams and records throttled partial text; the client's existing
1.2s poll renders it. No new transport, no new endpoint. This is a prerequisite
for stage B, which only replaces the delivery channel. All four parts shipped:

1. `assistant_turns.streamed_content` (nullable text), with a check constraint
   confining it to `queued` and `running`. The existing result check is
   untouched.
2. `AssistantGenerationService.generateStreaming({ ..., onDelta })`, which
   consumes `result.fullStream` to completion inside the worker's provider-call
   slot, so a dropped reader never aborts a generation the queue still owns.
3. A fenced `recordPartial(turnId, attempt, text)` across both stores, throttled
   in the worker so the write rate is bounded by wall-clock, not token rate.
4. Nonterminal turn views carry `partial: string | null`; the frontend renders it
   as the in-flight assistant message, replacing the bare thinking indicator.

The processor now has no buffered path: `generateStreaming` is the only call it
makes.

## Stage B — the SSE accelerator — landed

The worker publishes accumulated text, reasoning and tool-activity frames to a
Redis stream keyed `assistant:stream:${turnId}:${attempt}`. Frames are coalesced
to at most one flush every 50 ms: that is smooth enough for the browser without
turning every provider token into a Redis command and a full Markdown parse. The
stream keeps its latest 64 frames for ten minutes. Because every frame is an
accumulated value rather than a delta, a late or slow reader can discard any
intermediate frame and still recover from the next one.

`GET /v1/assistant/threads/:threadId/turns/:turnId/stream` first performs the
same owner-bound durable lookup as polling, emits a snapshot, then replays and
follows that Redis stream. It sends SSE keepalives and disables proxy buffering;
the production nginx `/api/` location already has buffering off and a 310-second
read timeout. The endpoint closes after a terminal `done` frame or a relay
failure. It never turns a relay failure into a failed generation.

The admin opens the authenticated response with the shared `ofetch` facade and
parses its `ReadableStream`; native `EventSource` cannot attach the Clerk bearer.
Polling continues every 1.2 seconds underneath. Live frames are an overlay on
the durable turn, fenced by attempt, and a shorter stale poll cannot regress a
newer live prefix. A `reset` frame clears the overlay before an internal BullMQ
provider retry. When polling sees terminal state, the authoritative persisted
answer replaces the overlay. If SSE is absent or drops without `done`, the
overlay is removed and polling continues alone.

The source's reserved answer height landed with the accelerator. The last
in-flight assistant article retains the same minimum height as the initial
thinking placeholder, and the scroll region disables browser overflow
anchoring. The question therefore stays where the explicit alignment put it
while the answer grows. A stop control remains deferred because stopping a
browser reader must not be confused with cancelling the durable queue job.

## Reasoning — landed

Reasoning did not wait for stage B; it rode in on stage A's stream, because the
same `fullStream` loop that yields text deltas yields reasoning deltas beside
them.

- **Ask for it.** OpenRouter returns reasoning deltas already — that is how the
  source's idle watchdog keeps a text-less thinking phase alive. OpenAI direct
  returns no raw chain of thought; it returns a summary, and only when
  `reasoningSummary` is sent (`@ai-sdk/openai@4.0.18`). Luna and Terra are the
  direct routes, so those two show a summary and the OpenRouter pair show live
  reasoning. That asymmetry is a provider fact, not a bug to chase.
- **Read it.** `textStream` is text deltas only, so reading it would discard
  reasoning silently. The service reads `result.fullStream` instead and splits
  `reasoning-delta` parts from text parts. The source's equivalent is one flag:
  `toUIMessageStream({ sendReasoning: true })`.
- **Store it.** `assistant_turns.reasoning_content` shares the partial recorder
  and attempt fence with streamed text but is retained at settlement, with a
  matching Mongo/document and DTO field. The admin renders the same collapsed
  disclosure live and after reload.

## Cost — landed

`result.usage` is read exactly once when the stream completes, converted to the
typed turn usage contract and persisted in PostgreSQL, MongoDB and the API view.
The assistant footer shows total tokens and `est. €…`; legacy turns and provider
responses without enough token data show neither fictional zero nor a cost.

`notes_ai` has this and most of it transfers:

- `completionCostEur(inputTokens, outputTokens, model, eurPerUsd)` is a pure
  `Decimal` function and ports as is, as does its table shape — `inputCost` and
  `outputCost` in **USD per single token** (`0.00000025` = $0.25/1M).
- The prices do **not** transfer, and the one overlap is a trap. Of the four
  models here only `qwen/qwen3.7-max` appears in the source's table, at
  $0.78 / $3.90 per 1M — OpenRouter now lists it at **$1.475 / $4.425**, nearly
  double. Copying that table would have silently under-reported the one model it
  covered. Prices verified 2026-08-02:

  | Model                     | Route         | Tier     | Input /1M | Cached in /1M | Cache writes /1M | Output /1M |
  | ------------------------- | ------------- | -------- | --------- | ------------- | ---------------- | ---------- |
  | `openai/gpt-5.6-luna`     | OpenAI direct | standard | $0.20     | $0.02         | not read         | $1.20      |
  | `openai/gpt-5.6-luna`     | OpenAI direct | fast     | $0.40     | $0.04         | $0.50            | $2.40      |
  | `openai/gpt-5.6-terra`    | OpenAI direct | standard | $2.00     | $0.20         | not read         | $12.00     |
  | `openai/gpt-5.6-terra`    | OpenAI direct | fast     | $4.00     | $0.40         | $5.00            | $24.00     |
  | `google/gemini-3.6-flash` | OpenRouter    | n/a      | $1.50     | not listed    | not listed       | $7.50      |
  | `qwen/qwen3.7-max`        | OpenRouter    | n/a      | $1.475    | not listed    | not listed       | $4.425     |

  The OpenAI rows are the pricing page's Standard and Fast mode tabs; fast is
  exactly 2× standard on every column it shares.

  Four dimensions the flat `inputCost`/`outputCost` pair cannot express, all of
  which the source's function silently ignores:

  1. **Context length.** Those OpenAI figures are the _short context_ column, and
     Luna carries surge pricing above 272K input tokens.
  2. **Cache writes**, priced separately from cache reads and above plain input.
  3. **Regional processing.** Data-residency endpoints add a 10% uplift for
     models released on or after 2026-03-05.
  4. **OpenRouter's "effective price"**, advertised 60–80% below list after
     caching — a rolling average of other people's traffic, not a rate we are
     charged. List price is the only honest basis here.

- The rate does not transfer either. The source fetches the ECB daily reference
  rate, caches it in Redis and keeps a rate table. **Decision: pin the rate as a
  dated constant instead.** The badge shows thousandths of a euro, where daily FX
  drift changes nothing, and a live rate would add an external dependency that
  can fail on a path that must never fail a turn.
- The hook differs. The source tags the message in `toUIMessageStream`'s
  `messageMetadata` at the `finish` part; here the worker reads `result.usage`
  once the stream completes and persists token counts as real columns rather than
  free-form metadata. Cost is stored as integer euro-micros with pricing version
  `2026-08-03`; pricing uses the provider's cached-input count where present.

## Fast mode — landed

The composer's "Fast" control maps to OpenAI's `service_tier`, the paid fast lane
the feedback module already describes as roughly twice the token price. The
pricing page's Fast mode tab confirms it for **both** Luna and Terra, at exactly
2× standard (table above, read 2026-08-02).

Four properties this shipped with, each of which would be a defect if dropped:

- **The turn records the tier it ran under**, not the one the browser asked for.
  `assistant_turns.service_tier` is fenced by the same check constraint as model
  and effort, and a retry reuses the persisted value — otherwise one turn could
  bill at two rates across its attempts.
- **A model that cannot sell the lane records `standard`.** The service
  normalises before anything is persisted, so a row is always repriceable from
  itself, and the OpenRouter branch omits the parameter rather than sending one
  that route would silently drop.
- **The control is disabled, not hidden**, on the OpenRouter models, with the
  reason in its tooltip. An operator who believes they bought speed they did not
  buy has been misled by the UI, not the provider.
- **The adapter translates the spelling.** OpenAI renamed the tier `fast` on
  2026-07-30 and accepts both names, but `@ai-sdk/openai@4.0.18` still types only
  `priority`. The vocabulary follows the current name and the boundary converts,
  exactly as public model ids stay separate from provider model ids.

Worth recording so nobody re-opens it: the 2026-07-30 announcement reads as
though Fast mode were exclusive to GPT-5.6 Sol, and the Luna and Terra model
pages mention no service tier at all. Both are about Sol _gaining_ the tier, not
about the other two lacking it. The pricing page is the authority.

The control is inherently partial, though, and that is a UI decision rather than
a bug: `service_tier` is an OpenAI parameter, so it can never apply to Gemini or
Qwen on the OpenRouter route. Half the model list will ignore it. Whatever the
composer does, it must not imply the fast lane was bought when the selected model
cannot buy it — and, since the tier doubles the bill, the persisted turn has to
record which tier it actually ran under, exactly as it records model and effort.

Two honest limits remain: cache-write charges, regional uplift and OpenAI
long-context surge pricing are not reported richly enough by this completion
path to reconstruct an invoice. Reasoning is already included in the SDK's
output total and cached reads are discounted separately. The badge is explicitly
an estimate, not accounting.

## References

- [Assistant backend mechanism](../modules/assistant.md)
- [Assistant screen](../../frontend/assistant.md)
- [Queue mechanism](./queues.md)
