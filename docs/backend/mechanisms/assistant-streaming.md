# Assistant streaming — durable turns with a live accelerator

Status: stages A and B landed (partial text over poll, then Redis-backed SSE),
including durable reasoning, tool traces, priced usage and stable answer layout.
Last verified: **2026-08-05**. Canonical design for live assistant text on
`/admin/assistant` without giving up the durable turn.

Server contract (routes, persistence, tools, cost):
[assistant module](../modules/assistant.md).
UI overlay, 1.2s poll and `ofetch` stream consume:
[assistant screen](../../frontend/assistant.md).

## Why this is not a one-line port

`notes_ai` runs `streamText` inside the HTTP request and treats SSE as a
best-effort accelerator over a durable thread. This codebase kept the durable
half (queued turn, BullMQ worker, idempotent replay, attempt fencing, retry)
and restored the accelerator in two stages: A over the existing poll, B over
Redis SSE. Three local constraints block copying the source shape:

1. **Generation does not run in the request.** `dev:http` and `dev:worker` are
   separate processes; tokens reach HTTP only through a broker (Redis, already
   required by the queue).
2. **A turn lives in two stores.** PostgreSQL `assistant_turns` owns fencing;
   MongoDB `conversation_threads` is what `toThreadView` serves. Partial text
   must reach both under the same attempt fence, or a reload can show a
   superseded attempt.
3. **The schema forbids nonterminal content.** `assistant_turns_result_check`
   keeps `assistant_content` null unless succeeded — load-bearing — so partials
   use `streamed_content` instead of relaxing that check.

## Invariants

- Persisted turn is source of truth; UI must be correct with the stream absent.
- Partial text is fenced by `(turnId, attempt)`; superseded writes are dropped.
- Partials are never promoted to the answer — only `markSucceeded` writes
  terminal content; a mid-stream death is `failed`.
- Partials clear on terminal state.
- Retry increments `attempt` and discards earlier partial text.

## Stage A — partial text over the existing poll — landed

Worker streams and records throttled partials; the client's 1.2s poll renders
them. No new transport. Four parts:

1. `assistant_turns.streamed_content` (nullable), check-constrained to
   `queued`/`running`; result check untouched.
2. `AssistantGenerationService.generateStreaming({ ..., onDelta })` consumes
   `result.fullStream` to completion inside the worker's provider-call slot so a
   dropped reader never aborts a queue-owned generation. No buffered path
   remains.
3. Fenced `recordPartial(turnId, attempt, text, …)` across both stores,
   wall-clock throttled in the worker.
4. Nonterminal turn views carry `partial: string | null` for the in-flight
   assistant message.

## Stage B — the SSE accelerator — landed

Worker publishes accumulated text, reasoning and tool-activity frames to Redis
stream `assistant:stream:${turnId}:${attempt}`. Frames coalesce to at most one
flush every **50 ms**; the stream keeps the latest **64** frames for **ten
minutes**. Every frame is an accumulated value (not a delta), so a late reader
may discard intermediates and recover from the next frame.

`GET /v1/assistant/threads/:threadId/turns/:turnId/stream` performs the same
owner-bound durable lookup as polling, emits a snapshot, then replays and
follows that Redis stream. It sends SSE keepalives (15s) and sets
`X-Accel-Buffering: no`; production nginx `/api/` already disables buffering
with a 310-second read timeout. The endpoint closes after a terminal `done`
frame or a relay failure — never turning a relay failure into a failed
generation.

Frame kinds: `snapshot`, `reset`, `text`, `reasoning`, `tools`, `done`, each
attempt-fenced. Client consume and overlay rules live on the
[assistant screen](../../frontend/assistant.md#client-transport-documented-exception).
A stop control remains deferred: stopping a browser reader must not be confused
with cancelling the durable queue job.

## Reasoning on the stream — landed

Same `fullStream` loop yields reasoning beside text. OpenRouter returns
reasoning deltas; OpenAI direct returns a summary only when `reasoningSummary`
is sent (`@ai-sdk/openai@4.0.18`) — Luna/Terra show a summary, OpenRouter pair
show live reasoning. Reading `textStream` would discard reasoning silently.
`assistant_turns.reasoning_content` shares the partial recorder and attempt
fence with streamed text but is **retained** at settlement (Mongo + DTO).

## Usage at stream completion

`result.usage` is read once when the stream completes and persisted as typed
turn usage. Rates, tier multiplier, pinned FX and operator-estimate limits:
[assistant module — Service tier, usage and cost](../modules/assistant.md#service-tier-usage-and-cost).

## References

- [Assistant module](../modules/assistant.md)
- [Assistant screen](../../frontend/assistant.md)
- [Queue mechanism](./queues.md)
- Relay source:
  [`assistant-stream.relay.ts`](../../../apps/backend/src/modules/assistant/assistant-stream.relay.ts)
