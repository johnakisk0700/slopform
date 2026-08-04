# Frontend component inventory

Search this inventory before adding UI. Selection order: **reuse a matching
project `Jts*` contract → use the HeroUI primitive directly → compose a new
documented `Jts*` only for real repeated product behaviour → semantic HTML.**
Never wrap a HeroUI component just to rename its props.

## Shared UI (`src/components/ui/`)

| Component | Contract | Owns |
| --------- | -------- | ---- |
| `JtsPageHeader.tsx` | [`jts-page-header.md`](jts-page-header.md) | One route's `h1` with the six-dot mark, back link, eyebrow, description and actions |
| `JtsBackLink.tsx` | [`jts-back-link.md`](jts-back-link.md) | Detail-screen exit: left chevron, wine, «Back to \<place\>» |
| `JtsStat.tsx` | [`jts-stat.md`](jts-stat.md) | One definition-list-safe metric: `dt`/`dd`, tone marker, decorative icon |
| `JtsDataTable.tsx` | [`jts-data-table.md`](jts-data-table.md) | Table naming, loading/empty/error, overflow, toolbar, client sort + pagination |
| `JtsLiveIndicator.tsx` | [`jts-live-indicator.md`](jts-live-indicator.md) | Polled-pane quiet refresh mark: no layout shift, no live region, no status colour |

`JtsBackLink` normally via `JtsPageHeader`'s `back` prop; render directly only
where there is no header. `JtsDataTable` owns states/framing; the page owns
`ColumnDef` columns, cell formatting, filters, row actions and API calls.
`JtsStat` sits in a page-owned labelled `dl`. `JtsLiveIndicator` takes a boolean
+ hidden sentence; show/hide hysteresis is in `src/lib/liveIndicator.ts`. Add a
prop/slot only after a real consumer needs it; update this inventory and the
focused contract in the same change.

## Domain components (`src/components/admin/`)

Admin shell and interaction boundaries — documented here until one grows a
reusable surface.

| Component | Owner | Owns |
| --------- | ----- | ---- |
| [`AdminShell.tsx`](../../../apps/admin/src/components/admin/AdminShell.tsx) | Admin shell | Desktop wine sidebar / mobile drawer, skip target, 200ms route entrance |
| [`AdminNavigation.tsx`](../../../apps/admin/src/components/admin/AdminNavigation.tsx) | Admin shell | Indexed nav landmark (sidebar + drawer via `variant`); "Soon" stamps |
| [`AdminUserMenu.tsx`](../../../apps/admin/src/components/admin/AdminUserMenu.tsx) | Admin shell | Operator popover, Appearance (`useTheme`), Theme picker (`usePalette`) |

`AdminNavigation` and `AdminUserMenu` mount twice — every internal id from
`useId`.

### Authentication surfaces

| Component | Owns |
| --------- | ---- |
| [`SignInLayout.tsx`](../../../apps/admin/src/components/admin/SignInLayout.tsx) | Sign-in frame + `SignInFormPlaceholder`. Used by the route and the pre-router wait in `App.tsx` |
| [`AuthPendingScreen.tsx`](../../../apps/admin/src/components/admin/AuthPendingScreen.tsx) | Private-route wait: brand lockup, breathing rule, `role="status"`. No title/action |
| [`AuthStatusScreen.tsx`](../../../apps/admin/src/components/admin/AuthStatusScreen.tsx) | `configuration` / `denied` / `failed` — each with one recovery action |

A wait is not a status: use `AuthPendingScreen` (or the sign-in placeholder),
never a card announcing auth in progress. `SignInPage` owns Clerk `appearance`
(flattens Clerk's card into the page card).

### Feedback conversations (`…/feedback/`)

Domain UI for one screen — full contract in
[`../feedback-conversations.md`](../feedback-conversations.md).

| Component | Owns |
| --------- | ---- |
| `CampaignHeader.tsx` | Responsive chrome (`CampaignHeader`) + `CampaignContext` outline for venue/exceptions |
| `ConversationList.tsx` | Filter, grouping, selection; triage weight on group heading; D17 start on the candidate row |
| `ConversationTranscript.tsx` | Actor-labelled transcript, attention highlighting, delivery state, composers |
| `ConversationDetails.tsx` | Respondent, goal progress, answers, notes, actions as labelled sections |
| `ConfirmAction.tsx` | Trigger + confirmation dialog for one consequential action |
| `AddNoteAction.tsx` | Staff note dialog (type, optional D16 subject, bounded text) |
| `FeedbackBadges.tsx` | Status descriptors as token-painted pills (own text always) |

Not a HeroUI `Chip` wrapper: `Chip` has no `info` slot. Descriptors from
`features/feedback/labels.ts`. Shared contract from this screen:
`JtsLiveIndicator` (two polling panes).

### Events and participants (`…/events/`, `…/participants/`)

| Component | Owns |
| --------- | ---- |
| `EventStatusChip.tsx` | One event status chip (list, event screen, profile dinner history) |
| `CreateEventAction.tsx` | «New event» dialog from list toolbar |
| `AddAttendeeAction.tsx` | Searchable attendee picker; already-on-event people omitted |
| `EventVenueCard.tsx` | Venue summary + compact modal editor |
| `VenueGoogleSelection.tsx` | Sole surface allowed to mount Google autocomplete/details or Embed fallback |
| `VenueDisplay.tsx` | No-request display: `VenueDetails` / `VenueCompact` |
| `VenuePill.tsx` | Plain-Maps-link venue label for dense rows (no Google UI Kit) |
| `GooglePlace*.tsx` | Isolated Google adapter: one selection-scoped Place Details → draft fields; UI Kit → Embed fallback |
| `ParticipantIdentity.tsx` | Monogram, name (optional profile link), distinguishing email |

Pure helpers beside them: `features/event/eventStatus.ts`,
`features/event/venue.ts`, `features/participants/search.ts` — no React imports.

**Venue / Google rules (inventory summary):** Normal cards, details, pills and
history rows never mount the Google adapter. Opening the editor mounts Place
Autocomplete (host-styled with `--jts-*` + `color-scheme` from `useTheme`);
selection → one `Place.fetchFields` for name/address/type; prediction text is
failure fallback; monotonic revision drops stale lookups. Attributed
details/photo only after fresh selection or explicit preview; UI Kit reject →
Maps Embed `place` iframe. Price range: dual-thumb 0–150 EUR step 5. Details-to-
draft is prototype-only — do not persist Google Place Name outside the session
without the legal/provider gate in `docs/deployment.md`; safe fallback is Place
ID + authored context. Browser key: Places API (New), Places UI Kit, Maps Embed;
referrer/API restricted. Failures surface as configuration errors (widget error
is non-discriminating). Seating (`table_no`) is read-only here; assignment
belongs to «Tables & matching».

## References

Verified 2026-07-23: [@heroui/react](https://www.heroui.com/) 3.2.2,
[@tanstack/react-table](https://tanstack.com/table/v8) 8.21.3,
[lucide-react](https://lucide.dev/) 1.25.0. HeroUI has no provider — import from
`@heroui/react`; icons from lucide-react.
