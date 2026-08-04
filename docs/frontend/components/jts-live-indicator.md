# JtsLiveIndicator

"This pane refreshes itself" mark for a polled surface: 14px muted stroke icon
that rotates while fetching and fades when idle, plus a visually hidden sentence
stating the behaviour once.

Source:
[`JtsLiveIndicator.tsx`](../../../apps/admin/src/components/ui/JtsLiveIndicator.tsx).
Hysteresis:
[`liveIndicator.ts`](../../../apps/admin/src/lib/liveIndicator.ts).

## Contract

| Prop | Type | Contract |
| ---- | ---- | -------- |
| `active` | `boolean` | Required. Pass TanStack Query `isFetching`. Component owns show/hide delay. |
| `label` | `string` | Required. Always-present, visually hidden sentence naming the pane's refresh. |
| `className` | `string?` | Layout only (placement in a header row). |

## Invariants

- **No layout shift.** Icon always occupies its box; only opacity/rotation change.
- **Hysteresis on paint.** Callers pass `isFetching` unchanged. Paint after
  `LIVE_INDICATOR_SHOW_DELAY_MS` (300 ms); once painted, hold
  `LIVE_INDICATOR_MIN_VISIBLE_MS` (450 ms) so snappy polls do not flash and the
  300 ms fade can read.
- **Not a live region.** No `role="status"` / `aria-live`. Hidden `label` states
  behaviour once; icon is `aria-hidden`.
- **No status by colour.** Reports "working" only — `text-ink-subtle`, no
  pulse/glow.
- **Reduced motion.** Base `globals.css` collapses animation; no motion branch
  in the component.

## Extension points

Pane adds the indicator to its header and writes its own `label`. Do not grow
into "last updated at" (pane-owned data; would need a live region). Do not move
delay into callers.

Reference consumers: feedback
[`ConversationList.tsx`](../../../apps/admin/src/components/admin/feedback/ConversationList.tsx),
[`ConversationTranscript.tsx`](../../../apps/admin/src/components/admin/feedback/ConversationTranscript.tsx)
([feedback-conversations.md](../feedback-conversations.md)); outbound queue
panes use the same mark.
