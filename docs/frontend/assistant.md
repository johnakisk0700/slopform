# AI assistant screen

Status: implemented, verified 2026-07-23 against React 19.2.8, HeroUI 3.2.2,
React Markdown 10.1.0, Mermaid 11.15.0, Zod 4.4.3 and the durable Assistant
HTTP contract.

## Purpose and boundary

`/admin/assistant` is the new-conversation surface;
`/admin/assistant/:threadId` is the exact resumable address of a durable
conversation. The screen owns model and reasoning-effort selection, durable
thread navigation, optimistic user turns, idempotent submission, polling and
recovery UI. The backend owns conversation history, provider credentials,
generation and authorization.

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
available height, including the local authentication-bypass banner and the
small-screen navigation header; `AssistantPage` therefore needs no viewport
height calculation.

Streaming, attachments and tools are not enabled. In particular, this screen
cannot mutate product data. Future database tools require an explicit
operator-confirmation contract before they can cross that boundary.

Sources:

- [`AssistantPage.tsx`](../../apps/admin/src/routes/AssistantPage.tsx) — durable
  transport, polling, history selection and recovery.
- [`components/admin/assistant/`](../../apps/admin/src/components/admin/assistant/) —
  copied chat composition, composer, message and rich-output renderer.
- [`schema.ts`](../../apps/admin/src/features/assistant/schema.ts) — exact model,
  request, thread and turn validation.
- [`globals.css`](../../apps/admin/src/styles/globals.css) — token-only
  `.assistant-markdown`, chart, Mermaid and thinking styles.

## HTTP contract

The shared API facade already has `/api` as its default base. Route code uses
the following paths without repeating that prefix:

| Operation    | Contract                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| List         | `GET /v1/assistant/threads` → `{ items: AssistantThreadSummary[] }`                                |
| Read         | `GET /v1/assistant/threads/:threadId` → owned thread with ordered durable turns                    |
| Create       | `POST /v1/assistant/threads` with `{ requestId, model, effort, content }` → thread plus first turn |
| Append       | `POST /v1/assistant/threads/:threadId/turns` with the same body → durable turn                     |
| Poll         | `GET /v1/assistant/threads/:threadId/turns/:turnId` while `queued` or `running`                    |
| Retry failed | `POST /v1/assistant/threads/:threadId/turns/:turnId/retry` → the same turn, next attempt           |
| Models       | `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, `google/gemini-3.6-flash`, `qwen/qwen3.7-max`       |
| Effort       | `low`, `medium`, `high`; backend default `low`                                                     |
| States       | `queued`, `running`, `succeeded`, `failed`                                                         |

`requestId` is a browser-minted UUID and is required on both creation writes.
The backend uniquely persists it and treats an identical replay as the same
turn. A lost `201` can therefore be retried without creating a second user turn
or queue job. This preserves the important generation-ID idempotency property
from `notes_ai`; a decorative chat copy without it would be a resumption bug in
a nicer shirt.

Every response enters the UI as `unknown` and must pass the feature-local Zod
schema. The full thread response is authoritative. The optimistic user message
uses its `requestId` only until that durable turn arrives.

## Flow

```mermaid
sequenceDiagram
  actor Operator
  participant SPA as Assistant route
  participant API as Nest API
  participant DB as PostgreSQL
  participant Queue as BullMQ worker
  participant Model as AI provider

  Operator->>SPA: Send content + model + effort
  SPA->>SPA: Mint requestId; show optimistic user turn
  SPA->>API: POST thread or turn
  API->>DB: Idempotently persist queued turn
  API->>Queue: Enqueue turn ID
  API-->>SPA: Durable thread / turn
  loop queued or running
    SPA->>API: GET same turn ID
    API-->>SPA: Validated turn state
  end
  Queue->>Model: Non-streaming generation
  Model-->>Queue: Complete text or provider failure
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
  by `AssistantChart`. Malformed source also falls back to code.
- Assistant renderer CSS uses only `--jts-*` semantic values. It follows the
  existing light/dark class automatically and introduces no parallel palette.
- The selector retains the source `notes_ai` geometry: an 8-high compact
  rounded trigger, a 20rem top-start popover with token border/radius, 0.75rem
  row padding and the effort control aligned beneath the provider marks.
  OpenAI, Gemini and Qwen use code-native `currentColor` brand marks; no remote
  images or fake letter tiles are rendered.

Tool cards and streamed reasoning parts from `notes_ai` are intentionally
absent: this transport currently receives one complete assistant text result.
Reasoning _effort_ is real provider input and is therefore retained; rendering
fictional tool/stream state would only disguise a missing backend contract.

## Invariants and recovery

- The selected thread ID lives in the route. Reloading or sharing
  `/admin/assistant/:threadId` restores that exact owned thread and polls its
  final queued/running turn. `/admin/assistant` deliberately stays a blank new
  conversation rather than guessing which history item the operator meant.
- Historical hydration scrolls to the end immediately, confirms on the next
  animation frame and keeps a short `ResizeObserver` while Markdown/Mermaid
  layout settles. A newly submitted question keeps the separate notes_ai
  question-alignment behavior.
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
visible page-header chrome. Conversation history is a named scroll region
containing a non-live `role="log"`, so opening an old thread does not announce
its entire transcript. A separate atomic live region announces only new-send
and lifecycle status; generation and failures also expose focused status and
alert semantics. The composer has a programmatic label, Enter sends,
Shift+Enter adds a line, and icon-only controls have accessible names. The
textarea itself suppresses HeroUI/native focus borders and rings; the enclosing
composer receives the token-based `focus-within` ring so keyboard focus remains
visible without drawing a box through the writing area.

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

Before adding tools, define durable tool-call and proposed-action records,
read-only database access, operator approval/rejection, idempotent execution and
an audit trail. A tool result should then become a typed message part and may
reuse the source project's card patterns. Do not squeeze it into assistant text.

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
