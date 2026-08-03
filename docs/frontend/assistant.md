# AI assistant screen

Status: implemented, verified 2026-08-03 against React 19.2.8, HeroUI 3.2.2,
React Markdown 10.1.0, Mermaid 11.15.0, Zod 4.4.3 and the durable Assistant
HTTP contract.

## Purpose and boundary

`/admin/assistant` is the new-conversation surface;
`/admin/assistant/:threadId` is the exact resumable address of a durable
conversation. The screen owns model and reasoning-effort selection, durable
thread navigation, optimistic user turns, idempotent submission, live SSE
acceleration, durable polling and recovery UI. The backend owns conversation
history, provider credentials, generation and authorization.

Both URLs deliberately share one optional route (`assistant/:threadId?`) so the
empty and durable screen remain one routing boundary instead of two duplicated
route definitions.

The replacement also carries an explicit live-alignment navigation state. All
assistant URLs share one `AdminShell` motion key, so creating or selecting a
durable thread preserves the mounted screen, scroll measurements and optimistic
transition instead of flashing through a page entrance. The navigation state
still identifies the created live thread for alignment and suppresses its
history-to-bottom hydration; ordinary links and reloads keep the normal
settled-history behavior.

The chat structure is a deliberate port of the proven `notes_ai` UI rather than
a new renderer: a narrow written-page message column, compact user ink-wash
turns, full-width assistant prose, a bottom-docked composer, a compact model
popover, quiet thinking copy and memoized Markdown messages. Join The Six
semantic tokens replace the source palette; the admin shell, Clerk gate and
HeroUI primitives remain native to this repository.

The assistant is the one edge-to-edge route inside `AdminShell`: the shell
removes its ordinary content width and padding for both assistant URLs, and the
route fills the shell's remaining flex height. It does not recreate the normal
page header, description or bordered page card. `#root` and `AdminShell` own the
available height. On narrow screens the assistant shell is exactly `100dvh`,
the navigation header is non-shrinking and the routed main takes the remaining
flex height; this prevents the reply-height observer from measuring a
content-sized scroller and feeding that result back into unbounded page growth.
`AssistantPage` therefore needs no viewport height calculation. Nothing is
stacked above the shell — the local authentication bypass is announced in the
sidebar's environment block, not by a banner that would shorten every route.

Answer text now arrives progressively through authenticated SSE, coalesced to
20 frames per second, while the existing 1.2-second poll continues underneath.
The live value renders under the id the durable answer will take, so the finished
reply replaces it in place. Live text is never an answer — it carries no copy or
attribution footer, keeps the activity marker, and is dropped the moment the
turn settles. See
[assistant streaming](../backend/mechanisms/assistant-streaming.md).

Attachments are not enabled. Tools are — nine of them, all read-only — so this
screen can look things up but cannot mutate product data. Future database
mutations require an explicit operator-confirmation contract before they can
cross that boundary; see
[the assistant module](../backend/modules/assistant.md).

Sources:

- [`AssistantPage.tsx`](../../apps/admin/src/routes/AssistantPage.tsx) — durable
  transport, polling, history selection and recovery.
- [`components/admin/assistant/`](../../apps/admin/src/components/admin/assistant/) —
  copied chat composition, composer, message and rich-output renderer.
- [`schema.ts`](../../apps/admin/src/features/assistant/schema.ts) — exact model,
  request, thread and turn validation.
- [`stream.ts`](../../apps/admin/src/features/assistant/stream.ts) — SSE frame
  validation, parsing and attempt-fenced live overlay.
- [`composerSettings.ts`](../../apps/admin/src/features/assistant/composerSettings.ts) —
  the persisted model and effort selection.
- [`failureMessages.ts`](../../apps/admin/src/features/assistant/failureMessages.ts) —
  operator copy for a failed request, by HTTP status.
- [`globals.css`](../../apps/admin/src/styles/globals.css) — token-only
  `.assistant-markdown`, chart, Mermaid and thinking styles.

## HTTP contract

This screen predates the generated API client and is its one documented
exception: it still calls the shared `ofetch` facade directly and validates
responses with `features/assistant/schema.ts`, because the polling flow owns
optimistic turns, idempotent replay and attempt fencing beyond the response
shape. It migrates to the generated `useCreateAssistantThread` /
`useGetAssistantTurn` hooks in its own change. Every other screen consumes the
generated hooks — see
[API contract and generated client](../backend/mechanisms/api-contract.md).

The shared API facade already has `/api` as its default base. Route code uses
the following paths without repeating that prefix:

| Operation    | Contract                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------- |
| List         | `GET /v1/assistant/threads` → `{ items: AssistantThreadSummary[] }`                                 |
| Read         | `GET /v1/assistant/threads/:threadId` → owned thread with ordered durable turns                     |
| Create       | `POST /v1/assistant/threads` with `{ requestId, model, effort, content }` → thread plus first turn  |
| Append       | `POST /v1/assistant/threads/:threadId/turns` with the same body → durable turn                      |
| Edit in new  | `POST /v1/assistant/threads/:threadId/branches` with the same body plus `sourceTurnId` → new thread |
| Poll         | `GET /v1/assistant/threads/:threadId/turns/:turnId` while `queued` or `running`                     |
| Live         | `GET /v1/assistant/threads/:threadId/turns/:turnId/stream` → best-effort authenticated SSE          |
| Retry failed | `POST /v1/assistant/threads/:threadId/turns/:turnId/retry` → the same turn, next attempt            |
| Models       | `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, `google/gemini-3.6-flash`, `qwen/qwen3.7-max`        |
| Effort       | `low`, `medium`, `high`; backend default `low`                                                      |
| Service tier | `standard`, `fast`; default `standard`, and forced to `standard` off the OpenAI route               |
| States       | `queued`, `running`, `succeeded`, `failed`                                                          |

`requestId` is a browser-minted UUID and is required on both creation writes.
The backend uniquely persists it and treats an identical replay as the same
turn. A lost `201` can therefore be retried without creating a second user turn
or queue job. This preserves the important generation-ID idempotency property
from `notes_ai`; a decorative chat copy without it would be a resumption bug in
a nicer shirt.

Every JSON response and every SSE data frame enters the UI as `unknown` and must
pass a feature-local Zod schema. The full thread response is authoritative. The
optimistic user message uses its `requestId` only until that durable turn
arrives. SSE uses the shared authenticated `ofetch` facade with
`responseType: "stream"`; native `EventSource` cannot send the Clerk bearer.

## Flow

```mermaid
sequenceDiagram
  actor Operator
  participant SPA as Assistant route
  participant API as Nest API
  participant Redis as Redis stream
  participant DB as PostgreSQL
  participant Queue as BullMQ worker
  participant Model as AI provider

  Operator->>SPA: Send content + model + effort
  SPA->>SPA: Mint requestId; show optimistic user turn
  SPA->>API: POST thread or turn
  API->>DB: Idempotently persist queued turn
  API->>Queue: Enqueue turn ID
  API-->>SPA: Durable thread / turn
  par Live accelerator
    SPA->>API: GET turn stream
    API->>Redis: Replay/follow attempt stream
    Queue->>Redis: Accumulated text/reasoning frames
    Redis-->>API: Replayable frames
    API-->>SPA: SSE frames
  and Durable authority
  loop queued or running
    SPA->>API: GET same turn ID
    API-->>SPA: Validated turn state
  end
  end
  Queue->>Model: Streaming generation
  Model-->>Queue: Text/reasoning deltas or provider failure
  Queue->>DB: Persist terminal turn
  SPA->>API: GET authoritative thread
  API-->>SPA: Ordered durable history
```

## Rendering contract

- Finalized messages are `React.memo` boundaries. Assistant Markdown is also
  memoized because parsing, sanitising and syntax highlighting dominate render
  cost; an older turn does not re-run that pipeline when page state changes.
- GFM tables, task lists, hard breaks and ordinary fenced code are supported.
  Code highlighting uses `rehype-highlight`.
- Raw model HTML is parsed, then sanitised, then highlighted — that plugin order
  is security-critical. The sanitiser adds only `mark`, `kbd`, `sub` and `sup`
  to its default GitHub schema. Event handlers and scripts are removed.
- Fenced `mermaid` is dynamically imported so Mermaid stays out of the initial
  bundle. It uses `securityLevel: "strict"`; invalid source falls back to code,
  and the existing `useTheme` store rerenders diagrams when light/dark changes.
- Fenced `chart` accepts the small JSON bar/line/sparkline contract implemented
  by `AssistantChart`. Malformed source also falls back to code. Optional `max`
  is the top of the scale the values were measured on, so an average of 4.2 on a
  1–5 rating draws as 4.2 of 5 rather than as a full bar; an unusable `max` is
  dropped on its own instead of failing the whole chart, because the values are
  still true. Bar rows give the category name an 11rem track in the text face,
  not the mono the value column needs for aligned digits — Greek dimension names
  truncated at the old 7rem. This renderer is shared with the feedback campaign
  summary
  accordion — see
  [Feedback conversations](feedback-conversations.md) — so the fence is a
  contract two prompts write against, not an assistant-only convenience.
- Assistant renderer CSS uses only `--jts-*` semantic values. It follows the
  existing light/dark class automatically and introduces no parallel palette.
- The selector retains the source `notes_ai` geometry: an 8-high compact
  rounded trigger, a 20rem top-start popover with token border/radius, 0.75rem
  row padding and the effort control aligned beneath the provider marks. Its
  selected value renders only the one-line thread title; the timestamp remains
  available in the open list and cannot make the closed toolbar jump from one
  line to two.
  OpenAI, Gemini and Qwen use code-native `currentColor` brand marks; no remote
  images or fake letter tiles are rendered.

Cards, reasoning, tool activity and cost all render from real state rather than
being imitated cosmetically from `notes_ai`:

- **Cards.** A fenced ` ```jts ` block in the assistant's markdown is parsed
  against a Zod discriminated union and rendered as `AssistantCard` — kinds
  `profile`, `event` and `conversation`. A block that fails to parse falls back
  to the raw fence rather than disappearing, because a card is model-authored
  text and the model can get it wrong. The three specimens in the cookbook go
  through the real `AssistantMarkdown`, so they cannot drift from the parser.
- **Reasoning.** `AssistantReasoningCard` shows provider reasoning as a collapsed
  disclosure while the turn is in flight and on settled historical turns.
- **Tool activity.** `AssistantToolCallCard` ports the Notes AI disclosure shape:
  operator label and state in the summary, with bounded JSON input/result on
  expansion. The same typed list comes from SSE while live and the durable turn
  after polling/reload.
- **Cost.** The settled footer shows total tokens and a clearly labelled
  estimated EUR cost when the provider supplied enough usage data. It uses the
  turn's persisted model/tier/price version, never the browser's current picker.
- **Copy.** A settled answer with no activity copies directly. When persisted
  reasoning or tool calls exist, the copy action offers answer-only or answer
  plus thinking and bounded tool input/result artifacts; both variants are
  formatted from that durable turn, never reconstructed from DOM text.

The rule the two share is the one worth keeping: nothing here renders fictional
state. Both surfaces exist because a durable field or a parsed contract backs
them.

## Invariants and recovery

- The selected thread ID lives in the route. Reloading or sharing
  `/admin/assistant/:threadId` restores that exact owned thread and polls its
  final queued/running turn. `/admin/assistant` deliberately stays a blank new
  conversation rather than guessing which history item the operator meant.
- Historical hydration restores the latest question at the same top offset as
  a live send, confirms on the next animation frame and keeps a short
  `ResizeObserver` while Markdown/Mermaid layout settles. Reloading or selecting
  a thread therefore cannot replace the question-aligned answer reserve with a
  bottom lock. The visible scroll viewport and newest question
  and the overlay composer's real top edge are measured with `ResizeObserver`;
  the genuinely visible remaining height moves unchanged from the waiting
  placeholder to the live answer and stays on the settled last answer. Matching
  dynamic bottom clearance keeps that answer out from behind the composer. The
  scroll region disables overflow anchoring, so neither first text nor
  settlement can pull the question back down. A new thread created by that turn
  also suppresses its one historical-hydration scroll, which would otherwise
  overwrite the live alignment when the server returns its id.
- Only one nonterminal turn exists per thread. Thread selection, new-thread
  creation and the composer are disabled while that turn is active.
- Poll failure retries `GET` for the same turn. Submission failure can replay
  the same `requestId`, restore the draft for revision (the next Send mints a
  new request ID and may use a different model/effort), or explicitly discard
  the draft and start a new conversation. These remedies remain enabled while
  the ordinary composer is blocked.
- A provider failure stays on its durable turn. Retry requeues that same failed
  turn and increments `attempt`; successful content is never destructively
  overwritten. Revising restores the failed input and sends it as a new turn in
  the same thread, preserving earlier successful context while the failed turn
  remains visible in the audit history.
- Editing any durable user message creates a new conversation. The backend
  copies the immutable prefix before that turn and generates from the edited
  replacement; the original thread and every later answer remain untouched.
  The current model, effort and service tier apply to the new branch turn.
- Raw backend/provider messages are never displayed. Stable failure codes map
  to operator-safe text.
- The selected model and `low`/`medium`/`high` effort are remembered in local
  storage for the next new turn. Their actual values remain persisted per turn,
  so history never depends on browser preference. Retrying a durable failed turn
  reuses that turn's original model and effort exactly.
- The default is `google/gemini-3.6-flash`; there is no silent model/provider
  substitution.

## Accessibility and responsive states

The route keeps one visually hidden `h1` because the chat deliberately has no
visible page-header chrome. The conversation toolbar does not mirror transient
page phases: loading and success are intentionally silent there, while the
conversation body and its live region own generation and failure feedback.
Conversation history is a named plain scroll region
containing a non-live `role="log"`, so opening an old thread does not announce
its entire transcript. It deliberately has no scroll-edge gradient: the newest
question aligns close to its top edge and must remain fully legible there. A
separate atomic live region announces only new-send
and lifecycle status; generation and failures also expose focused status and
alert semantics. The composer has a programmatic label, Enter sends,
Shift+Enter adds a line, and icon-only controls have accessible names. The
textarea itself suppresses HeroUI/native focus borders and rings; the enclosing
composer changes its existing three-sided token border on `focus-within`, so
keyboard focus remains visible without drawing a ring or a false bottom edge
through the docked writing area.

The writing area is two fixed rows that scroll, with no drag handle: the
composer is what the message column docks against, so a resizable box would let
the page be resized from its own footer. The column drops its left padding at
`lg`, so the written page begins on the composer's line of writing rather than
inset from it, and the scroll region keeps a permanent gutter so an appearing
scrollbar cannot recentre the column under a composer that does not move. The
`❯` prompt is set in the mono family — in the sans face that glyph has no
descender and floats above the caret it sits beside.

Loading another conversation blocks only submission. It does not disable or
replace the textarea, model controls or send icon, so the docked composer stays
visually stable while the transcript changes underneath it.

Thinking copy and the settled model/cost/token stamp use the same mono
marginalia face as the source chat. The answer, activity disclosures and footer
share one left rail; the compact copy action stays in that footer without
changing its text baseline or horizontal rhythm.

The narrow message column and docked composer remain usable at the 20rem minimum
viewport. Reduced motion disables the thinking opacity animation through both
the app-wide policy and its focused fallback.

## Tests and extension points

`apps/admin/test/assistant-contract.spec.ts` protects:

- a direct comparison with the backend's exported model/default and
  effort/default constants, preventing two independently-green copies;
- exact Qwen3.7 Max and OpenRouter adapter/provider-option coverage, plus its
  durable database allow-list;
- the required idempotency UUID and durable lifecycle schemas;
- frontend/backend title and terminal-state boundaries;
- flattening durable turns into the copied renderer contract;
- safe failure copy and relative API paths;
- real raw-HTML sanitisation, GFM tables and syntax highlighting;
- the memoized renderer and security-critical plugin order.
- URL-based exact resume, hydration scrolling, reactive Mermaid theming,
  guarded submission and non-live historical logs;
- explicit retry/revise/discard recovery affordances.

Read-only tools now have durable typed call/result records. Before adding
mutating tools, define separate proposed-action records, operator
approval/rejection, idempotent execution and an audit trail. A proposed action
may reuse the source project's card patterns. Do not squeeze it into assistant
text.

## References

- [Frontend foundation](../frontend.md)
- [Assistant backend mechanism](../backend/modules/assistant.md)
- [Queue mechanism](../backend/mechanisms/queues.md)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
  and [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
  official model references, verified 2026-07-23.
- [Gemini 3.6 Flash on OpenRouter](https://openrouter.ai/google/gemini-3.6-flash),
  verified 2026-07-23.
- [Qwen3.7 Max on OpenRouter](https://openrouter.ai/qwen/qwen3.7-max), verified
  2026-07-23. The copied selector exposes its reference options: text-only
  reasoning with `low`, `medium` and `high` effort.
- [React Markdown](https://github.com/remarkjs/react-markdown),
  [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize), and
  [Mermaid security](https://mermaid.js.org/config/usage.html), verified
  2026-07-23.
