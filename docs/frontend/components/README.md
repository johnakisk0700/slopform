# Frontend component inventory

Search this inventory before adding UI. Selection order: **reuse a matching
project `Jts*` contract → use the HeroUI primitive directly → compose a new
documented `Jts*` only for real repeated product behaviour → semantic HTML.**
Never wrap a HeroUI component just to rename its props.

## Shared UI (`src/components/ui/`)

| Component              | Contract                                         | Owns                                                                                     |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `JtsPageHeader.tsx`    | [`jts-page-header.md`](jts-page-header.md)       | One route's `h1` with the wine marker, eyebrow, description and route-owned actions      |
| `JtsStat.tsx`          | [`jts-stat.md`](jts-stat.md)                     | One definition-list-safe metric: `dt`/`dd`, tone marker, decorative icon                 |
| `JtsDataTable.tsx`     | [`jts-data-table.md`](jts-data-table.md)         | Table naming, loading/empty/error states, overflow, toolbar and client sort + pagination |
| `JtsLiveIndicator.tsx` | [`jts-live-indicator.md`](jts-live-indicator.md) | A polled pane's quiet refresh mark: no layout shift, no live region, no status colour    |

`JtsDataTable` owns table states and framing; the page owns TanStack `ColumnDef`
columns, cell formatting, filters, row actions and API calls. `JtsStat` renders
inside a page-owned labelled `dl`. `JtsLiveIndicator` takes a boolean and a
hidden sentence — the pane keeps its query, its interval and its own header. Add
a prop or slot only after a real consumer needs it, then update this inventory
and the focused contract in the same change.

## Domain components (`src/components/admin/`)

Admin shell and interaction boundaries — documented inline here rather than with
their own contract file until one grows a reusable surface.

| Component                                                                             | Owner       | Owns                                                                                  |
| ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| [`AdminShell.tsx`](../../../apps/admin/src/components/admin/AdminShell.tsx)           | Admin shell | Desktop wine sidebar / mobile drawer layout, skip target and the 200ms route entrance |
| [`AdminNavigation.tsx`](../../../apps/admin/src/components/admin/AdminNavigation.tsx) | Admin shell | Indexed nav landmark shared by sidebar and drawer via a `variant` prop; "Soon" stamps |
| [`AdminUserMenu.tsx`](../../../apps/admin/src/components/admin/AdminUserMenu.tsx)     | Admin shell | Operator identity popover and the light/dark/auto appearance control (`useTheme`)     |

`AdminNavigation` and `AdminUserMenu` mount twice (sidebar + drawer), so every
internal id comes from React's `useId`.

### Feedback conversations (`src/components/admin/feedback/`)

The panes and dialogs of the post-event feedback inbox. They are domain UI for
one screen, not shared contracts: their props carry conversation read models and
callbacks, and their full contract lives in
[`../feedback-conversations.md`](../feedback-conversations.md).

| Component                     | Owns                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CampaignHeader.tsx`          | The back link, campaign title, pause/resume/close actions and the campaign tallies                                                                                                                                                                                             |
| `ConversationList.tsx`        | Filter, grouping and selection of a campaign's conversations. The group heading carries the triage weight (own fill, glyph, count, `aria-labelledby` on its `section`) and a row states only what the heading does not; `aria-current` on the row; hosts the D17 start trigger |
| `ConversationTranscript.tsx`  | Actor-labelled transcript, per-message attention highlighting, delivery state, staff and dev-only composers                                                                                                                                                                    |
| `ConversationDetails.tsx`     | The respondent, goal progress, answers, notes and actions as labelled sections                                                                                                                                                                                                 |
| `ConfirmAction.tsx`           | A trigger plus its confirmation dialog, stating the consequence of one action                                                                                                                                                                                                  |
| `StartConversationAction.tsx` | The D17 attendee picker that opens a missing conversation                                                                                                                                                                                                                      |
| `AddNoteAction.tsx`           | The staff note dialog: type, an optional D16-candidate subject, bounded text                                                                                                                                                                                                   |
| `FeedbackBadges.tsx`          | Renders status descriptors as HeroUI chips, always with their own text                                                                                                                                                                                                         |

The status badge maps a domain tone onto HeroUI `Chip` props through a pure
function in `features/feedback/labels.ts`, which is the mapping — not a wrapper
that renames HeroUI's props. The one shared contract the screen did produce is
`JtsLiveIndicator`, because two panes poll and both needed the same
no-layout-shift, no-live-region treatment.

## References

Verified 2026-07-23: [@heroui/react](https://www.heroui.com/) 3.2.2,
[@tanstack/react-table](https://tanstack.com/table/v8) 8.21.3,
[lucide-react](https://lucide.dev/) 1.25.0. HeroUI has no provider — import
everything from `@heroui/react`; icons are lucide-react.
