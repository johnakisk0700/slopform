# Frontend component inventory

Search this inventory before adding UI. Selection order: **reuse a matching
project `Jts*` contract → use the HeroUI primitive directly → compose a new
documented `Jts*` only for real repeated product behaviour → semantic HTML.**
Never wrap a HeroUI component just to rename its props.

## Shared UI (`src/components/ui/`)

| Component              | Contract                                         | Owns                                                                                     |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `JtsPageHeader.tsx`    | [`jts-page-header.md`](jts-page-header.md)       | One route's `h1` with the six-dot mark, the back link, eyebrow, description and actions  |
| `JtsBackLink.tsx`      | [`jts-back-link.md`](jts-back-link.md)           | The one way out of a detail screen: left chevron, wine, «Back to \<place\>»              |
| `JtsStat.tsx`          | [`jts-stat.md`](jts-stat.md)                     | One definition-list-safe metric: `dt`/`dd`, tone marker, decorative icon                 |
| `JtsDataTable.tsx`     | [`jts-data-table.md`](jts-data-table.md)         | Table naming, loading/empty/error states, overflow, toolbar and client sort + pagination |
| `JtsLiveIndicator.tsx` | [`jts-live-indicator.md`](jts-live-indicator.md) | A polled pane's quiet refresh mark: no layout shift, no live region, no status colour    |

`JtsBackLink` is normally reached through `JtsPageHeader`'s `back` prop, which is
what fixes its position; render it directly only where there is no page header
to hold it. `JtsDataTable` owns table states and framing; the page owns TanStack `ColumnDef`
columns, cell formatting, filters, row actions and API calls. `JtsStat` renders
inside a page-owned labelled `dl`. `JtsLiveIndicator` takes a boolean and a
hidden sentence — the pane keeps its query, its interval and its own header;
show/hide hysteresis lives in the mark (`src/lib/liveIndicator.ts`), not in
callers. Add a prop or slot only after a real consumer needs it, then update
this inventory and the focused contract in the same change.

## Domain components (`src/components/admin/`)

Admin shell and interaction boundaries — documented inline here rather than with
their own contract file until one grows a reusable surface.

| Component                                                                             | Owner       | Owns                                                                                                                           |
| ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`AdminShell.tsx`](../../../apps/admin/src/components/admin/AdminShell.tsx)           | Admin shell | Desktop wine sidebar / mobile drawer layout, skip target and the 200ms route entrance                                          |
| [`AdminNavigation.tsx`](../../../apps/admin/src/components/admin/AdminNavigation.tsx) | Admin shell | Indexed nav landmark shared by sidebar and drawer via a `variant` prop; "Soon" stamps                                          |
| [`AdminUserMenu.tsx`](../../../apps/admin/src/components/admin/AdminUserMenu.tsx)     | Admin shell | Operator identity popover, the light/dark/auto appearance control (`useTheme`) and the six-palette Theme picker (`usePalette`) |

`AdminNavigation` and `AdminUserMenu` mount twice (sidebar + drawer), so every
internal id comes from React's `useId`.

### Authentication surfaces (`src/components/admin/`)

| Component                                                                                 | Owns                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`SignInLayout.tsx`](../../../apps/admin/src/components/admin/SignInLayout.tsx)           | The sign-in frame — panel, page-owned `h1`, the card that holds the form — plus `SignInFormPlaceholder`, the form-shaped wait. Rendered by the route _and_ by the pre-router waiting tree in `App.tsx` |
| [`AuthPendingScreen.tsx`](../../../apps/admin/src/components/admin/AuthPendingScreen.tsx) | The wait before a private route can be decided: brand lockup, one breathing rule, `role="status"`. No title, no action, nothing to leave                                                               |
| [`AuthStatusScreen.tsx`](../../../apps/admin/src/components/admin/AuthStatusScreen.tsx)   | The three auth states that do have something to say — `configuration`, `denied`, `failed` — each with one recovery action                                                                              |

A wait is not a status: it gets `AuthPendingScreen` (or, on `/sign-in`, the
placeholder inside the real frame), never a card announcing that authentication
is happening. `SignInPage` owns the Clerk `appearance`, which flattens Clerk's
own card into the page's card and turns «Secured by Clerk» into that card's
bottom band.

### Feedback conversations (`src/components/admin/feedback/`)

The panes and dialogs of the post-event feedback inbox. They are domain UI for
one screen, not shared contracts: their props carry conversation read models and
callbacks, and their full contract lives in
[`../feedback-conversations.md`](../feedback-conversations.md).

| Component                    | Owns                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CampaignHeader.tsx`         | Two exports. `CampaignHeader` is the page's own responsive chrome: mobile DOM order is back link, `h1`, actions; from `sm` the actions lift beside the back link above the title. `CampaignContext` owns one wrapping outline for venue plus exceptions beside the summary, and renders nothing when neither exists |
| `ConversationList.tsx`       | Filter, grouping and selection of a campaign's conversations. The group heading carries the triage weight (own fill, glyph, count, `aria-labelledby` on its `section`) and a row states only what the heading does not; `aria-current` on the row; hosts the D17 start trigger                                      |
| `ConversationTranscript.tsx` | Actor-labelled transcript, per-message attention highlighting, delivery state, staff and dev-only composers                                                                                                                                                                                                         |
| `ConversationDetails.tsx`    | The respondent, goal progress, answers, notes and actions as labelled sections                                                                                                                                                                                                                                      |
| `ConfirmAction.tsx`          | A trigger plus its confirmation dialog, stating the consequence of one action                                                                                                                                                                                                                                       |
| `AddNoteAction.tsx`          | The staff note dialog: type, an optional D16-candidate subject, bounded text                                                                                                                                                                                                                                        |
| `FeedbackBadges.tsx`         | Renders status descriptors as its own token-painted pills, always with their own text                                                                                                                                                                                                                               |

The status badge is deliberately **not** a HeroUI `Chip` wrapper: `Chip` has no
`info` slot, so the slate statuses could not be expressed through it, and half a
status set painted by HeroUI and half by hand would be worse than painting all
of it. `FeedbackBadges` renders plain markup against its own tone maps, and
`features/feedback/labels.ts` supplies the descriptors (`key`, `label`, `tone`,
`emphasis`) — a domain mapping, not a rename of HeroUI's props. The one shared contract the screen did produce is
`JtsLiveIndicator`, because two panes poll and both needed the same
no-layout-shift, no-live-region treatment. The D17 start trigger has no
component of its own: it lives on the candidate row inside `ConversationList`,
because the row _is_ the candidate.

### Events and participants (`src/components/admin/events/`, `.../participants/`)

The operations screens' domain UI. Same rule as the inbox: these carry event and
participant read models, so they are not shared `Jts*` contracts.

| Component                  | Owns                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EventStatusChip.tsx`      | One event status as a chip. The events list, the event screen and the profile's dinner history all use it, so a status reads the same in all three       |
| `CreateEventAction.tsx`    | The «New event» dialog: title and start, opened from the list's toolbar rather than standing permanently above it                                        |
| `AddAttendeeAction.tsx`    | The searchable attendee picker — name, email and phone per row, with everyone already on the event left out                                              |
| `EventVenueCard.tsx`       | Venue summary plus a compact modal editor (icon section cues, dual-thumb EUR price slider, Luna switch)                                                  |
| `VenueGoogleSelection.tsx` | The only editor surface allowed to mount Google autocomplete/details or its Embed fallback; manual Place ID is advanced and preview is explicit/selected |
| `VenueDisplay.tsx`         | The no-request display contract: persisted `VenueDetails` for the event card and `VenueCompact` for dense non-list surfaces                              |
| `VenuePill.tsx`            | The plain-Maps-link venue label for repeated event/history rows; it has no dependency on the Google UI Kit adapter                                       |
| `GooglePlace*.tsx`         | The isolated Google adapter: one selection-scoped Place Details call seeds canonical draft fields; attributed UI Kit details fall back to Embed          |
| `ParticipantIdentity.tsx`  | One person said the same way everywhere: monogram square, name (optionally linked to the profile) and the email that tells two people of a name apart    |

Their vocabulary is pure and lives beside them: `features/event/eventStatus.ts`
maps a status to its label, chip colour and transition verb and states the edit
and insert gates; `features/event/venue.ts` formats the generated venue values
and builds the zero-request Maps deep-link; `features/participants/search.ts`
owns the accent-folding match shared by the picker and the participants list.
None imports React. Normal event cards, venue details, pills, compact displays
and history rows never mount the Google adapter. Opening the venue editor mounts
the standard Place Autocomplete element (host-styled with `--jts-*` tokens and
`color-scheme` from `useTheme`). Its selection event constructs a standalone
`Place` from the selected ID and makes one `Place.fetchFields` request for the
canonical display name, formatted address and primary type. Prediction text is
the failure fallback, and a monotonic revision prevents a slower prior lookup
from replacing the latest selection. The operator reviews those suggestions and
authors price context before saving. Attributed details/photo load only after a fresh
selection or the explicit preview action. If Places UI Kit rejects that explicit
preview, the same Place ID is shown through a Maps Embed `place` iframe instead.
Typical per-person price range is always a dual-thumb slider (0–150, step 5,
EUR) with From/To labels under the track.

That details-to-draft behavior is prototype-only, not a production
compliance decision. Google-supplied Place Name or other content must not be
persisted outside the session without the legal/provider gate documented in
`docs/deployment.md`; the safe fallback remains Place ID plus independently
authored operator context.

The browser key must permit Places API (New) for autocomplete, Places UI Kit for
attributed details, and Maps Embed API for the no-charge map fallback; it must
remain referrer/API restricted. Google currently documents
[Maps Embed requests](https://developers.google.com/maps/documentation/embed/usage-and-billing)
as free with unlimited usage. Google failures are deliberately reported as
configuration errors: the browser cannot reliably distinguish project API
activation, billing, key API permissions or an HTTP referrer mismatch from the
widget's generic error event, so the UI does not fabricate a narrower cause.

Seating is deliberately **not** here. `table_no` renders as a read-only chip on
the event screen; assigning it belongs to the «Tables & matching» area, which
is where a card per table with the people at it will earn its keep.

## References

Verified 2026-07-23: [@heroui/react](https://www.heroui.com/) 3.2.2,
[@tanstack/react-table](https://tanstack.com/table/v8) 8.21.3,
[lucide-react](https://lucide.dev/) 1.25.0. HeroUI has no provider — import
everything from `@heroui/react`; icons are lucide-react.
