# Post-event feedback MVP — implementation plan (v2, simplified)

> **History. Delivered — do not build from this.** The post-event feedback module described here was built and has since been reorganised. For what the code does now read [the module doc](../backend/modules/post-event-feedback.md); this file explains why it was shaped that way.

Date: **2026-07-25** — v2, same-day revision after a deliberate simplification
pass. Supersedes the earlier v1 of this file entirely.

Derived from [`docs/post-event-feedback-handover.md`](post-event-feedback-handover-2026-07-25.md),
[ADR 0008](../decisions/0008-post-event-feedback-conversations.md), the
[module contract](../backend/modules/post-event-feedback.md) and the Notion
pages «7. Επικοινωνίες», «Βάση feedback», «Πεδία και ερωτήσεις». The
simplification pass amends parts of ADR 0008 (§9 lists every delta); the
implementing agents must fold those amendments into the maintained docs in the
same change that lands the code, per `AGENTS.md`.

Net effect of the pass: **13 planned PostgreSQL tables → 7**, one Mongo
collection, no projection/sync tables, no snapshot-copy machinery. Guiding
rule: _facts live in one place; conversations are touched only by explicit
human actions; incomplete data is acceptable, inconsistent data is not._

## 1. The design in one paragraph

Staff finishes a stub event and launches a campaign. One Mongo conversation is
created per present + opted-in participant with a phone. Inbound WhatsApp (or
the local simulator) lands in a durable PostgreSQL ingress row, is
materialized idempotently into the Mongo transcript, and triggers an
extraction job that live-selects the table's candidates, asks the model for a
structured proposal, validates it in application code, persists directed
answers/notes in PostgreSQL and queues the next bot reply through the outbox.
Staff watches everything on one conversations screen and intervenes only via
explicit buttons (take over / send / resume / close / start conversation).
STOP is deterministic and final. Auto-close happens only via STOP, expiry or
completion.

## 2. Locked decisions

- **D1 — Stub events.** Minimal `events` + `event_attendees` (staff-entered;
  no bookings/payments/venues). Attendance corrections are **updates, never
  deletes**: «δεν ήρθε τελικά» = `present=false`, «την ξεχάσαμε» = insert.
  The admin UI exposes no row deletion for finished events.
- **D2 — Local-first testing.** v1 is validated by one operator playing all
  participants through a simulated transport (WP8). Real Wasender stays
  behind the existing env gates; the staging acceptance pack (§8, "gate")
  remains mandatory before any real human.
- **D3 — Questionnaire v1 locked** (version `1`): `event_score` (int 1–5,
  subjectless), `liked`, `meet_again`, `avoid` (each 0..N candidate IDs,
  `avoid` softly phrased) + bounded side notes (`activity_interest |
general`). All questions skippable (goal `skipped`, no answer row). Greek
  draft copy in §5; copy edits never require schema changes.
- **D4 — Consent v1 = boolean + audit.** `post_event_feedback_whatsapp_opt_in`
  on `participants`, default `false`; every change and every STOP writes an
  audit event. This is an _eligibility gate_, not consent evidence — the real
  consent ledger, wording, legal review and Meta/BSP classification are a
  named gate before real humans (§8). No `participant_channel_consents`
  table in v1.
- **D5 — Auto-send after validation.** No quiet-window coalescing; every
  inbound triggers extraction; per-conversation serialization + extraction
  cursor + outbox dedupe suppress duplicate replies. (Outbox keeps a `held`
  status value so a supervised mode remains a config away, later.)
- **D6 — Mongo conversation doc v2** (§6): transcript, goals,
  lifecycle × control, `phoneAtLaunch`, `needsAttention`, extraction cursor.
  **No candidate list is stored** (see D16). Deterministic
  `_id = uuidv5(campaignId, participantId)` → launch replay is naturally
  idempotent and at most one conversation per (campaign, participant) ever
  exists. A conversation closed by STOP is never recreated or reopened.
- **D7 — One recovery direction: PostgreSQL-first, forward materialization.**
  Ingress row = durable acknowledgement + dedupe boundary; Mongo transcript
  materialized idempotently from ingress; extraction writes PG results behind
  unique constraints + cursor; replies via PG outbox (email-relay lease
  pattern); known outbound correlates to outbox, unknown outbound forces
  human control. Replay repairs forward; nothing claims exactly-once.
- **D8 — Webhook scope.** Only `messages.upsert` + `messages.update`
  subscribed (`messages-personal.received` off — duplicate inbound). Handler
  = validate → single ingress INSERT → enqueue → 200. Provider retry is
  undocumented, so the insert stays minimal and heavily tested; inbound loss
  is treated as unrecoverable.
- **D9 — Inbound resolution via Mongo.** Phone → conversation lookup is a
  Mongo query on `(phoneAtLaunch, lifecycle=open)` backed by a **partial
  unique index** (unique open conversation per phone, purpose-scoped). Zero
  match → D10. AI never guesses which event or person a message belongs to.
- **D10 — Unmatched traffic (shared session).** Ingress rows matching no open
  conversation keep metadata only (direction, JID, provider ID, timestamp),
  **no text**, status `ignored_unmatched`, counted in metrics, never
  AI-processed. Keeps WordPress-era traffic out and satisfies minimization.
- **D11 — Reminder/expiry defaults.** One reminder at
  `FEEDBACK_REMINDER_AFTER_HOURS=24` if no reply to the intro; expiry at
  `FEEDBACK_EXPIRE_AFTER_HOURS=72` → `closed/expired`. Env-configurable.
- **D12 — Extraction execution.** Dedicated `feedback` queue,
  `feedback.extract.v1` job, structured output (Zod-validated), provider
  registry reuse, default model `google/gemini-3.6-flash` (configurable),
  Greek-first prompts/fixtures. `extraction_meta` records model, confidence
  **and the exact candidate IDs supplied in that run** (required for
  debugging under D16's live selection).
- **D13 — Safety travels the ordinary pipeline** (amended 2026-07-26, after a
  live acceptance run where a harassment disclosure made the model refuse
  structured generation and the failed job recorded nothing at all). Safety
  signals — from the model or the deterministic keyword tripwire — raise
  `needsAttention` and write one audit event, and that is the whole operator
  signal. Ordinary notes are **not** suppressed, and a safety signal does not
  force a handoff; only an explicit model `handoff` swaps in the neutral copy.
  A permanently failed extraction falls back to one ordinary note plus one
  acknowledgement so a dead run never leaves a turn unmarked. The restricted
  `safety_reports` table stays deferred to the pre-real-humans gate. See
  [the module doc](../backend/modules/post-event-feedback.md#d13-safety-content-travels-the-ordinary-pipeline).
- **D14 — STOP.** Case-, whitespace- and accent-insensitive: `STOP`,
  `STOP ALL`, `UNSUBSCRIBE`, `ΔΙΑΚΟΠΗ`, `ΣΤΟΠ`. Checked deterministically at
  materialization, before any AI call, effective in both control modes:
  close (`stopped`), cancel queued outbox rows, flip the opt-in boolean off +
  audit, send exactly one confirmation.
- **D15 — Clerk stays staff-only.** Participants are not Clerk users and
  never need to be: they are rows in `participants` and talk only via
  WhatsApp. No WordPress→Clerk bridging exists in this feature.
- **D16 — Live candidate selection (replaces the frozen snapshot).**
  Candidates are selected **at extraction/validation time** from
  `event_attendees` (`present = true`, minus the respondent) through **one
  shared helper** used by both prompt building and subject validation.
  Attendance corrections therefore flow into all _future_ turns
  automatically («ξεχάσαμε τη Ρούλα» → fix attendance → the bot knows her
  from the next turn on). Two deliberate limits: answered goals are **never
  auto-reopened** when a candidate appears late, and each run's candidate set
  is recorded in `extraction_meta` (D12) so behavior stays auditable.
- **D17 — No automatic propagation from event facts to conversations.**
  Conversations auto-close only via STOP / expiry / completion. Everything
  else is a human button + audit event: `Close` (reason `cancelled`) for the
  wrongly-included attendee; `Start conversation` on the conversations screen
  for a late-added attendee (creates the missing conversation on the spot —
  create-if-missing per D6, never after STOP). No follow-up rounds are ever
  triggered in other people's conversations.
- **D18 — Unknown-name degradation + FK policy.** A mention whose subject
  cannot be resolved to a current candidate becomes a **subjectless note**
  (name stays in the text, flagged for review) — never a guessed subject ID.
  Feedback tables FK `participants`/`feedback_campaigns` with
  `ON DELETE RESTRICT` and **never** reference `event_attendees` rows;
  participant deletion is a future explicit workflow, not a casual action.
  Admin UI renders a defensive «άγνωστος συμμετέχων» fallback for any
  dangling cross-store ID.

## 3. Out of scope (unchanged non-goals + explicit deferrals)

All ADR 0008 / handover non-goals stand (no support inbox, no backfill, no
media understanding, no segments/summaries, no AI-owned side effects, no
autonomous launch, no participant-visible received feedback). Deferred by
this plan: consent ledger + legal/Meta classification work, `safety_reports`
table, participant-profile given/received views, Wasender staging acceptance
pack (all gate items before real humans, §8), and any aggregate analytics
beyond the v1 screens.

## 4. PostgreSQL — the seven tables

Exact columns/constraints are the implementing agent's job; shapes and
uniqueness rules below are contract. Existing `audit_events` is reused for:
launch/pause/close, takeover/resume, STOP, opt-in changes, external-outbound
takeover, safety flag, staff send, close/cancel, start-conversation.

```text
events                     id, title, starts_at,
                           status draft|scheduled|finished|cancelled, timestamps
event_attendees            event_id, participant_id, table_no, present bool
                           UNIQUE(event_id, participant_id)
                           corrections are UPDATEs (D1); FK participants RESTRICT
feedback_campaigns         id, event_id UNIQUE (one campaign per event),
                           question_set_version, questions jsonb (copy at launch),
                           status launched|paused|closed, launched_at/by, timestamps
feedback_answers           campaign_id, conversation_id, respondent_participant_id,
                           subject_participant_id NULL, question_key, value_int NULL,
                           source_message_ids uuid[], extraction_meta jsonb
                           (model, confidence, candidate IDs of the run), timestamps
                           UNIQUE NULLS NOT DISTINCT
                           (conversation_id, question_key, subject_participant_id)
feedback_notes             same directionality; note_type activity_interest|general;
                           text ≤ ~500 chars; subject NULLABLE (D18 degradation);
                           source_message_ids; extraction_meta; status new|dismissed
provider_message_ingress   provider_message_id, chat_jid, direction,
                           phone_e164 NULL, text NULL (only when matched, D10),
                           observed_at, processing_status pending|materialized|
                           ignored_unmatched|failed, matched_conversation_id NULL
                           UNIQUE(chat_jid, provider_message_id)
message_outbox             conversation_id, campaign_id,
                           kind intro|reply|reminder|staff|system, body,
                           status pending|held|sending|sent|failed|cancelled,
                           dedupe_key UNIQUE, created_by_staff NULL,
                           provider_log_id, provider_message_id,
                           delivery_status error|pending|sent|delivered|read|played,
                           delivery timestamps   (deliveries folded in — no extra table)
```

Plus one new column on the existing `participants`:
`post_event_feedback_whatsapp_opt_in boolean default false` (D4). Question
definitions are versioned TypeScript constants; the campaign row stores the
jsonb copy used at launch (git owns definition history — no
`feedback_question_sets` table).

## 5. Question set v1 — locked structure, draft Greek copy

Structure is contract (D3); copy is editable product text:

```text
intro       Γεια σου {name}! Εδώ η ομάδα του Join The Six 🙂 Ελπίζουμε να
            πέρασες όμορφα. Θα ήθελες να μας πεις 2-3 πράγματα για τη βραδιά;
            Παίρνει λιγότερο από 2 λεπτά. (Αν δεν θες μηνύματα, γράψε ΣΤΟΠ.)
event_score Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;
liked       Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα
            καλή εντύπωση;
meet_again  Με ποιους από την παρέα θα ήθελες να ξαναβρεθείς σε επόμενο
            τραπέζι;
avoid       Υπάρχει κάποιος ή κάποια που θα προτιμούσες να μην πετύχεις ξανά;
            Μένει αυστηρά μεταξύ μας.
closing     Τέλεια, ευχαριστούμε πολύ! Ό,τι άλλο θες να μας πεις, είμαστε εδώ. 🙌
stop_ack    Έγινε, δεν θα ξαναλάβεις μηνύματα από εμάς σε αυτό το νούμερο.
reminder    Καλημέρα {name}! Αν έχεις 2 λεπτά, θα χαρούμε πολύ να μάθουμε πώς
            σου φάνηκε η βραδιά 🙂 (Γράψε ΣΤΟΠ αν δεν θες μηνύματα.)
```

## 6. Mongo conversation doc v2 (purpose `post_event_feedback`)

```text
_id: uuidv5(campaignId, participantId), schemaVersion: 2,
purpose: 'post_event_feedback', channel: 'whatsapp',
campaignId, respondentParticipantId, phoneAtLaunch,
lifecycle { state: open|closed, reason?: completed|stopped|expired|cancelled, closedAt? },
control   { mode: bot|human, changedAt, source: staff_action|external_outbound },
goals     [ { key, ordinal, prompt, status: pending|asked|answered|skipped } ],
messages  [ { id, seq (contiguous), actor: bot|participant|staff|system, text,
              providerMessageId?, ingressId?, outboxId?, at } ],
extraction { cursorSeq, lastRunAt?, model? },
needsAttention: bool, remindedAt?, createdAt, updatedAt
```

Indexes: partial unique `(phoneAtLaunch)` where open + purpose (D9);
`(campaignId)` for the grouped admin list. No candidate list in the doc
(D16). Message append is idempotent by `ingressId`/`outboxId`. Messages
capped (~150) with a byte guard; hitting the cap sets `needsAttention`
instead of dropping. Only `actor: participant` messages may support
answers/notes. v1 assistant documents are never reinterpreted.

## 7. Runtime pipeline (recovery direction D7)

```text
webhook / dev injector
  → validate + normalize (existing edge)
  → INSERT provider_message_ingress (UNIQUE dedupe) → 200
  → enqueue feedback.materialize.v1(ingressId)

materialize (idempotent, reloads state)
  → resolve phone → open conversation (D9; unmatched → metadata-only, D10)
  → STOP check (D14) before any AI
  → append to Mongo transcript (idempotent by ingressId)
  → participant inbound → enqueue feedback.extract.v1
  → outbound observed: correlate to outbox → mark delivery cols;
    no outbox match → control=human + audit (external channel activity)

extract (serialized per conversation;
         job id feedback-extract-v1-<conversationId>-<latestSeq>)
  → reload conversation; skip if closed / human control / cursor ≥ latestSeq
  → candidates = sharedHelper(eventId, respondentId)   ← live select (D16)
  → prompt: full transcript + questions + candidates + accepted results
  → structured proposal { answers[], notes[], nextGoal, reply,
                          handoff, safetySignal, confidence }
  → validation: provenance exists · participant-only testimony · allowed
    keys/types · subject ∈ current candidates (else subjectless note, D18) ·
    subject ≠ respondent · replay-safe (unique constraints + cursor) ·
    lifecycle/control/opt-in permit reply
  → persist answers/notes, advance cursor, update goals,
    outbox reply (dedupe_key = conversationId + cursorSeq),
    all goals terminal → close(completed) + closing copy

outbox relay + deliver (email-outbox lease pattern)
  → TRANSPORT_MODE=simulated → sim sink | =wasender → sendText with pacing
    (min interval per shared session + jitter; staggered launch sends)
  → unknown-outcome sends never blindly retried (reconcile via provider
    status first) · messages.update → delivery columns

reminder / expiry sweeps
  → reload state; skip closed/human/opted-out; expiry closes (expired)
    and cancels queued outbox rows
```

Staff sends go through the same outbox (`kind: staff`) after explicit
takeover; resume is explicit. Every outbound is correlated except true
external sends, which trigger the takeover rule.

## 8. Work packages

Each WP is self-contained: `pnpm check` green, focused tests, docs-impact
update in the same change. Sizes: S ≈ half day, M ≈ 1–2 days, L ≈ 2–4 days.

- **WP0 — Product contract & fixtures (S).** Question constants v1 (§5),
  STOP matcher (D14, accent/case folding) + tests, Greek fixture transcripts
  (happy path, burst, two-«Κώστας» ambiguity, unknown name → subjectless
  note, unrelated chat, safety language, STOP mid-flow, staff follow-up).
  _Deps: none._
- **WP1 — Stub events slice (M).** `events` + `event_attendees` + migrations,
  Nest module (staff CRUD, status transitions, attendance/table editing with
  update-only corrections, audit), the **shared candidate/eligibility
  helper** (D16), minimal admin screens. Adds the opt-in boolean + audit to
  the participants module (D4). _Deps: none._
- **WP2 — Feedback persistence (M).** §4 feedback tables + constraints
  (answer uniqueness, ingress dedupe, RESTRICT FKs) + Drizzle schema +
  repositories + constraint tests. _Deps: WP1 (event FK), WP0 (question keys)._
- **WP3 — Mongo schema v2 (M).** §6 doc, Zod validators, repository
  (create-from-launch with deterministic _id, idempotent append,
  lifecycle/control transitions, cursor advance, needsAttention), indexes,
  size guards, tests. _Deps: WP0 (goal keys)._
- **WP4 — Ingress + materialization (L).** Durable webhook consumer behind
  existing env gates; `feedback` queue; materialize job with D9/D10/D14 +
  external-takeover rule; replay/crash tests (duplicate webhook, double
  materialize, out-of-order). _Deps: WP2, WP3._
- **WP5 — Extraction + reply loop (L).** `feedback.extract.v1` per §7:
  live-select via WP1 helper, structured output + Zod, full validation
  incl. subjectless degradation, cursor idempotency, goal advancement,
  completion, safety → D13, token-estimate logging, eval run against WP0
  fixtures. _Deps: WP4, WP0._
- **WP6 — Outbox relay + transport (M).** Lease relay (email pattern),
  simulated sink + Wasender adapter behind `TRANSPORT_MODE`, pacing/stagger,
  delivery-column updates from `messages.update`, cancel-on-STOP/expiry,
  ambiguous-send reconciliation. _Deps: WP2 (+WP4 wiring)._
- **WP7 — Campaign service + schedulers (M).** Launch (gate: event finished ∧
  present ∧ opt-in ∧ phone; create conversations + staggered intros),
  pause/close, `Start conversation` action (D17), reminder + expiry sweeps
  (D11), audit. _Deps: WP2–WP6._
- **WP8 — Dev simulation transport, backend only (S/M).**
  `TRANSPORT_MODE=simulated`: outbound sink storing sim messages + dev-only
  authenticated inject endpoint («inbound as any phone», same normalized
  event → same ingress path). The operator-facing composer is part of WP9
  (U2). _Deps: WP4 interfaces (parallelizable against the normalized-event
  contract)._
- **WP9 — Admin conversations UI (L).** The v1 centerpiece per §11:
  three-pane inbox grouped by event/campaign (list with progress / control /
  attention badges → transcript pane → details pane with answers, notes and
  actions), actions: take over / staff send (outbox) / resume / close /
  start conversation; dev «Reply as {name}» composer when simulated (U2);
  per-event Results tab (U4); TanStack Query polling (U3); unknown-id
  fallback (D18); campaign pause. Uses existing `Jts*` components per the
  frontend handbook. _Deps: WP7 APIs (read models can start against WP2/WP3)._

Execution order: `WP0 ∥ WP1` → `WP2 ∥ WP3` → `WP4` → `WP5 ∥ WP6 ∥ WP8` →
`WP7` → `WP9`.

**Gate pack (not a WP, mandatory before real humans):** Wasender staging
acceptance (linked-client outbound observation, webhook retry behavior,
session disconnect, ambiguous sends), consent research + ledger + legal
wording, Meta/BSP classification, `safety_reports` table, canary event with
kill switch.

## 9. Deltas vs ADR 0008 / handover (fold into docs when landing)

- Campaign recipient PG record → **removed**; the Mongo doc carries
  phone/state and the admin list reads Mongo projections (assistant-list
  precedent). ADR 0008's authority table changes accordingly.
- Frozen candidate snapshot → **live selection at extraction time** (D16)
  with per-run candidate recording in `extraction_meta`; the launch snapshot
  now covers only the question set (jsonb on the campaign row).
- `feedback_question_sets`, `feedback_candidate_snapshots`,
  `message_deliveries`, `participant_channel_consents`, `safety_reports` →
  not created in v1 (constants / doc fields / outbox columns / boolean+audit
  / deferred, respectively).
- Handover open decisions now closed: questionnaire copy+types (D3), note
  types (D3), coalescing (D5 — no), reminder/expiry (D11), Mongo evolution
  (D6), recovery protocol (D7). Still open on purpose: linked-client
  outbound + webhook retry (gate pack), summaries/segments (only after
  measured failures), consent wording/legal/Meta (gate pack).

## 10. End-to-end acceptance scenario (local, simulated)

1. Create stub event, add 6 imported participants, set tables, mark present,
   mark finished; flip opt-in on for all 6.
2. Launch campaign → 6 conversations, 6 staggered intros in the sim sink.
3. Play the characters through the injector: one happy path; one
   multi-message burst; one ambiguous «ο Κώστας ήταν τέλειος» with two Kostas
   candidates (expect clarification or low-confidence skip — never a guessed
   subject); one who praises «η Ρούλα» while Roula is not yet an attendee
   (expect a subjectless note flagged for review); one STOP (immediate close,
   single ack, opt-in flipped off + audit, queued sends cancelled); one
   silent (reminder at +24h, expiry at +72h).
4. Mid-campaign, mark Roula present (correction, not delete) → conversations
   that have not passed the people questions include her from the next turn
   (D16); press `Start conversation` to open Roula's own thread (D17).
5. Mark one attendee as wrongly present → press `Close` on their
   conversation (reason cancelled, audit event). Nothing else changes
   anywhere (no cascades).
6. Take over one conversation, staff-send from the drawer, resume; staff text
   is context, never testimony. Inject an outbound with no outbox record
   (manual WhatsApp Web simulation) → control flips to human + audit.
7. Verify: every answer/note carries respondent, optional subject, source
   message IDs and the run's candidate set in `extraction_meta`; replaying
   materialization and extraction jobs changes nothing.
8. Open the event's Results tab and confirm the full answer/note list matches
   what the six conversations produced.

## 11. Admin UI decisions (2026-07-25)

- **U1 — Three-pane inbox layout** for the conversations screen: left, the
  conversation list grouped by event/campaign with progress / bot-human /
  needs-attention badges; center, the actor-labelled transcript; right, the
  details pane (structured answers, notes, goal progress, actions). Helpdesk
  ergonomics: watching several live conversations means switching selection,
  not navigating pages.
- **U2 — Simulator lives inside the conversation view.** When
  `TRANSPORT_MODE=simulated`, the transcript pane shows a dev-only
  «Reply as {name}» composer that posts to the WP8 inject endpoint. No
  separate simulator screen in v1.
- **U3 — TanStack Query polling** (refetchInterval ≈ 3–5s on the open
  conversation, slower on the list, paused on hidden tab). WebSockets/SSE
  deliberately deferred: one operator watching one screen does not justify
  push infrastructure yet.
- **U4 — Per-event Results tab**: a clean filterable list of all
  answers/notes for the campaign (filter by question, participant, review
  status) — the original «Βάση feedback» done-criterion from Notion. No
  charts, no matrix in v1.

Frontend agents must read `docs/frontend.md`, `docs/frontend/theming.md` and
the `Jts*` component inventory before building, and follow the component
selection hierarchy from `AGENTS.md`.
