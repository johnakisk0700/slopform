# JtsLiveIndicator

`JtsLiveIndicator` is the "this pane refreshes itself" mark for a polled
surface. It renders a 14px muted stroke icon that rotates while a query is
fetching and fades out when it is not, plus a visually hidden sentence stating
the behaviour once.

Source:
[`JtsLiveIndicator.tsx`](../../../apps/admin/src/components/ui/JtsLiveIndicator.tsx).
Temporal hysteresis:
[`liveIndicator.ts`](../../../apps/admin/src/lib/liveIndicator.ts).

It exists because a screen that reloads behind an operator's back should say so.
Before it, the feedback inbox refetched on a timer with nothing on screen
acknowledging it, so a transcript that grew on its own read as a glitch.

## Contract

| Prop        | Type      | Contract                                                                          |
| ----------- | --------- | --------------------------------------------------------------------------------- |
| `active`    | `boolean` | Required. Pass TanStack Query's `isFetching`. The component owns show/hide delay. |
| `label`     | `string`  | Required. The always-present, visually hidden sentence naming the pane's refresh. |
| `className` | `string?` | Layout only (placement inside a header row).                                      |

## Invariants

- **No layout shift.** The icon always occupies its box; only opacity and
  rotation change, so a poll never nudges the header beside it.
- **Hysteresis on paint.** Callers pass `isFetching` unchanged. The icon paints
  only after the fetch has been active for
  `LIVE_INDICATOR_SHOW_DELAY_MS` (300 ms), and once painted it stays for at
  least `LIVE_INDICATOR_MIN_VISIBLE_MS` (450 ms). Snappy background polls do
  not flash; a linger is still visible long enough for the 300 ms opacity
  fade to read.
- **Not a live region.** There is no `role="status"` and no `aria-live`:
  announcing a three-second poll would be noise. The hidden `label` states the
  behaviour once and the rotation is decorative reinforcement, which is why the
  icon is `aria-hidden`.
- **No status by colour.** It reports "working", never a condition anyone must
  act on. It stays `text-ink-subtle` in both themes and never pulses or glows —
  the theming invariant against glows applies here first.
- **Reduced motion.** The base layer in `globals.css` collapses animation under
  `prefers-reduced-motion`, leaving the icon still and legible; the component
  adds no motion branch of its own.

## Extension points

A pane that polls adds the indicator to its own header and writes its own
`label`. Do not grow it into a "last updated at" readout: a timestamp is data
the pane owns, not a shared affordance, and it would need a live region to be
useful. Do not move the delay into callers — every polled pane should inherit
the same hysteresis.

Reference consumers: the feedback inbox's conversation list and transcript
headers —
[`ConversationList.tsx`](../../../apps/admin/src/components/admin/feedback/ConversationList.tsx)
and
[`ConversationTranscript.tsx`](../../../apps/admin/src/components/admin/feedback/ConversationTranscript.tsx),
contract in [`feedback-conversations.md`](../feedback-conversations.md); the
outbound queue panes use the same mark.
