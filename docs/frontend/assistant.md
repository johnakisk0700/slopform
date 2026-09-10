# AI assistant screen

Status: implemented, verified 2026-08-05 against React 19.2.8, HeroUI 3.2.2,
React Markdown 10.1.0, Mermaid 11.15.0, Zod 4.4.3 and the durable Assistant
HTTP contract.

## Purpose and boundary

`/admin/assistant` is the new-conversation surface;
`/admin/assistant/:threadId` is the exact resumable address. Both share one
optional route (`assistant/:threadId?`) and one `AdminShell` motion key so
create/select keeps the mounted screen. The screen owns model and effort
selection, thread navigation, optimistic turns, idempotent submission, live SSE
overlay, durable polling and recovery UI. The backend owns history, credentials,
generation and authorization — see
[the assistant module](../backend/modules/assistant.md). Poll and SSE stage
mechanics:
[assistant streaming](../backend/mechanisms/assistant-streaming.md).

Chat composition is a deliberate port of `notes_ai` (narrow message column,
ink-wash user turns, full-width assistant prose, docked composer, compact model
popover, quiet thinking, memoized Markdown) with house semantic tokens (`--jts-*`)
and native shell/Clerk/HeroUI. It is the one edge-to-edge route inside
`AdminShell` (no ordinary page card/header). On narrow screens the shell is
`100dvh` so the reply-height observer never measures a content-sized scroller.
Auth bypass is announced in the sidebar environment block, not a banner.

Attachments are off. Tools are on (nine, read-only). Future mutations need an
operator-confirmation contract first — see the module.

Sources: [`AssistantPage.tsx`](../../apps/admin/src/routes/AssistantPage/AssistantPage.tsx),
[`components/admin/assistant/`](../../apps/admin/src/components/admin/assistant/),
[`features/assistant/`](../../apps/admin/src/features/assistant/)
(`schema.ts`, `stream.ts`, `composerSettings.ts`, `failureMessages.ts`),
token-only styles in [`globals.css`](../../apps/admin/src/styles/globals.css).

The page composes the existing conversation and composer UI through
[`useAssistantControls`](../../apps/admin/src/routes/AssistantPage/useAssistantControls.ts).
That hook owns drafts, submit/branch/revise actions and thread selection.
Its local `useAssistantSettings` owns persisted pickers; `useAssistantSession` owns
requests, cancellation, optimistic turns, SSE/poll reconciliation and recovery.
`useAssistantScroll.ts` contains the alignment refs shared with actions and the
measurement, live-send alignment and history hydration effects. Recovery helpers
live with the session; transport stays in an adjacent file. These extractions
preserve the lifecycle and direct-transport exception below.

## Client transport (documented exception)

This screen predates the generated API client and is the one documented
exception in [root AGENTS.md](../../AGENTS.md) and
[apps/admin/AGENTS.md](../../apps/admin/AGENTS.md): it calls the shared
`ofetch` facade directly with generated HTTP request/response types because
polling owns optimistic turns, idempotent replay and attempt fencing beyond
the response shape. Composer and branch editors trim and bound user input at
submission; outgoing typed requests are sent directly. SSE frames and saved
picker values retain their untyped-input parsers. It migrates to generated hooks in its own change.
Every other screen uses generated hooks — see
[API contract](../backend/mechanisms/api-contract.md).

Server routes, models, effort, tier, statuses and idempotency tuple:
[HTTP contract](../backend/modules/assistant.md#http-contract). The shared
facade already prefixes `/api`; route code uses `/v1/assistant/...` paths.
Create/append/branch send `{ requestId, model, effort, serviceTier?, content }`
(`sourceTurnId` on branch). `requestId` is a browser-minted UUID; identical
replay recovers a lost `201` without a second turn.

While `queued`/`running`, the page polls `GET …/turns/:turnId` every **1.2s**
and opens `GET …/turns/:turnId/stream` via authenticated `ofetch` with
`responseType: "stream"` (native `EventSource` cannot send the Clerk bearer).
SSE data frames enter as `unknown` and must pass a feature-local Zod schema.
HTTP responses use the generated contract. The full thread response is authoritative; the
optimistic user message keys on `requestId` until the durable turn arrives.
Live frames overlay the durable turn under the id the answer will take; they
carry no copy/attribution footer, keep the activity marker, and drop on settle.
A shorter stale poll cannot regress a newer live prefix; `reset` clears the
overlay before an internal BullMQ provider retry. If SSE is absent or drops
without `done`, polling continues alone.

```mermaid
sequenceDiagram
  actor Operator
  participant SPA as Assistant route
  participant API as Nest API

  Operator->>SPA: Send content + model + effort
  SPA->>SPA: Mint requestId; optimistic user turn
  SPA->>API: POST thread or turn
  API-->>SPA: Durable thread / turn
  par Live accelerator
    SPA->>API: GET turn stream
    API-->>SPA: SSE frames
  and Durable authority
  loop queued or running
    SPA->>API: GET same turn ID
    API-->>SPA: Validated turn state
  end
  end
  SPA->>API: GET authoritative thread
  API-->>SPA: Ordered durable history
```

## Rendering contract

The existing visual tuning is intentional. Code cleanup must preserve message
widths, spacing, docked composer geometry, scroll/hydration alignment, motion,
and reasoning/tool presentation, including JSON syntax colouring. A request
to simplify implementation does not authorize removing these affordances.

- Finalized messages and assistant Markdown are `React.memo` boundaries
  (parse/sanitize/highlight dominate cost).
- GFM tables, task lists, hard breaks, fenced code; highlighting via
  `rehype-highlight`. Raw HTML: parse → sanitize → highlight (order is
  security-critical). Sanitiser adds only `mark`, `kbd`, `sub`, `sup` to the
  default GitHub schema.
- Fenced `mermaid`: dynamic import, `securityLevel: "strict"`, Mermaid `base`
  theme with `themeVariables` / `themeCSS` from `--jts-color-*` (hex via canvas
  — Mermaid cannot parse `oklch()` / `color-mix()`). Flowchart nodes may use
  `:::decision|info|data|ok|risk|ext`; classDefs from tokens — sources never
  include `%%init%%`, `style` or `classDef`. Invalid → code fallback; `useTheme`
  rerenders on light/dark.
- Fenced `chart`: small JSON bar/line/sparkline via `AssistantChart`. Optional
  `max` is the measurement scale top (4.2 on 1–5 draws as 4.2 of 5); unusable
  `max` drops alone. Bar category names get an 11rem text-face track. Shared
  with the feedback campaign summary —
  [Feedback conversations](feedback-conversations.md).
- Assistant CSS uses only `--jts-*`. Model selector keeps `notes_ai` geometry
  (8-high trigger, 20rem popover); selected value is one-line title only.
  OpenAI/Gemini/Qwen use code-native `currentColor` brand marks.
- Empty-conversation suggestions use HeroUI ghost buttons with an arrow icon;
  choosing a suggestion still only fills the composer draft.

Live and settled state from real fields / parsed contracts — never cosmetic
fiction:

- **Cards.** Fenced ` ```jts ` → Zod discriminated union → `AssistantCard`
  (`profile` | `event` | `conversation`). Parse failure → raw fence. Cookbook
  specimens go through real `AssistantMarkdown`. Fields pair muted Lucide icons
  with visible sentence-case labels; absent data still omits the complete row.
  Cards have neutral outlines and fit their content height, including in grids.
  A tinted identity icon and bold name head the card; compact icon badges sit
  below the name. `needsAttention: true` adds a danger-soft `Needs attention`
  badge before quiet state/control badges. False or omitted flags add no
  attention badge or reassuring status. A separator divides the header from
  the fields; empty field lists and status groups render no space or divider.
- **Reasoning.** `AssistantReasoningCard` collapsed disclosure in flight and on
  history. OpenAI direct shows a summary when requested; OpenRouter shows live
  reasoning — provider asymmetry, not a UI bug.
- **Tool activity.** `AssistantToolCallCard`: operator label/state in summary,
  bounded, indented JSON on expand; same typed list from SSE live and the
  durable turn after poll/reload. JSON keys use primary ink, strings use
  tinted ink, and numbers/literals use accent ink. The renderer emits escaped
  React text with token spans; it never injects payload HTML.
- **Cost.** Settled footer: total tokens and labelled estimated EUR from the
  turn's persisted model/tier/price version — never the browser picker.
- **Copy.** Settled answer with no activity copies directly; with reasoning/tool
  artifacts, answer-only or answer-plus-thinking/tools, formatted from the
  durable turn (not DOM). Copy glyph start-aligned in its 28px hit target on
  the answer column's left rail.

## Invariants and recovery

- Selected thread ID lives in the route. `/admin/assistant` stays blank new;
  reload of `/:threadId` restores that thread and polls its final
  queued/running turn.
- Historical hydration restores the latest question at the same top offset as a
  live send, confirms on the next frame, and keeps a short `ResizeObserver`
  while Markdown/Mermaid settles. Visible remaining height moves from waiting
  placeholder → live answer → settled last answer; dynamic bottom clearance
  keeps it clear of the composer. Overflow anchoring is off. A newly created
  live thread suppresses one historical-hydration scroll.
- One nonterminal turn per thread; selection, new-thread and composer disable
  while active.
- Poll failure retries the same turn `GET`. Submission failure can replay the
  same `requestId`, restore the draft (next Send mints a new id) or discard to
  a new conversation — remedies stay enabled while the ordinary composer is
  blocked.
- Provider failure stays on its durable turn. Retry requeues that turn and
  increments `attempt`. Revising restores failed input as a new turn; the failed
  turn remains in audit history.
- Editing any durable user message branches a new conversation (immutable
  prefix); current model/effort/tier apply to the new branch turn.
- Raw backend/provider messages never display; stable failure codes map to
  operator-safe text.
- Model and effort remembered in local storage for the next new turn; per-turn
  persisted values win for history and retry. Default
  `google/gemini-3.6-flash`; no silent substitution. Fast control disabled (not
  hidden) on OpenRouter models, with tooltip reason.

## Accessibility and responsive states

One visually hidden `h1`. Toolbar does not mirror transient page phases;
conversation body and live region own generation/failure. History is a named
plain scroll region with non-live `role="log"`. Separate atomic live region for
new-send and lifecycle only. Composer: programmatic label, Enter sends,
Shift+Enter newline, accessible names on icon-only controls. Textarea
suppresses HeroUI/native focus rings; enclosing composer uses `focus-within` on
its three-sided token border. Two fixed scrolling rows, no drag handle. Left
padding drops at `lg`; permanent scrollbar gutter. `❯` prompt in mono.
Loading another conversation blocks only submission — composer chrome stays
stable. Thinking copy and settled model/cost stamp use the same mono
marginalia. Usable at 20rem minimum viewport; reduced motion disables thinking
opacity animation.

## Tests and extension points

`apps/admin/test/assistant-contract.spec.ts` protects fast-lane eligibility and
turn flattening. Focused assistant stream, copy and artifact suites cover
live/persisted prefix reconciliation, retry reset, SSE parsing, copied activity
and retained reasoning/tool/usage data. Markdown parsing retains its existing
raw → sanitize → highlight pipeline.

Before mutating tools: separate proposed-action records, operator
approval/rejection, idempotent execution and audit — do not squeeze into
assistant text.

## References

- [Frontend foundation](../frontend.md)
- [Assistant module](../backend/modules/assistant.md)
- [Assistant streaming](../backend/mechanisms/assistant-streaming.md)
- [Queue mechanism](../backend/mechanisms/queues.md)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
  [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
  [Gemini 3.6 Flash](https://openrouter.ai/google/gemini-3.6-flash),
  [Qwen3.7 Max](https://openrouter.ai/qwen/qwen3.7-max)
- [React Markdown](https://github.com/remarkjs/react-markdown),
  [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize),
  [Mermaid security](https://mermaid.js.org/config/usage.html)
