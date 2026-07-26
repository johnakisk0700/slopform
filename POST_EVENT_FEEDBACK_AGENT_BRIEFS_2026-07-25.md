# Post-event feedback — agent briefs (2026-07-25)

Copy-paste prompts for dispatching one agent per work package. Source of
truth: `POST_EVENT_FEEDBACK_PLAN_2026-07-25.md` (referenced below as "the
plan"). Suggested routing: **WP9 → Opus 5** (frontend/visual); **WP0–WP8 →
GPT / Grok 4.5** (backend). WP1's small admin screens are deliberately plain
CRUD — any model is fine there; the visual showcase is WP9.

Dispatch order: `WP0 ∥ WP1` → `WP2 ∥ WP3` → `WP4` → `WP5 ∥ WP6 ∥ WP8` →
`WP7` → `WP9`. Never give two concurrent agents overlapping file ownership;
the boundaries below are disjoint on purpose.

Every prompt already embeds the house rules (read docs first, update docs in
the same change, `pnpm check` green, stay in scope). If an agent reports a
conflict between the plan and ADR 0008 / the handover, the plan §9 wins —
that agent must also fold the corresponding doc amendment into its change.

---

## WP0 — Product contract & fixtures (backend, S)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, then POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D3, D14),
§5 and §8/WP0. Do not read or modify unrelated modules.

Implement, in apps/backend:
1. Versioned question-set constants (version 1) exactly per plan §5:
   keys event_score (int 1–5, subjectless), liked, meet_again, avoid
   (candidate-ID sets), plus note types activity_interest|general. Include
   the Greek copy strings as data, editable without schema changes.
2. A deterministic STOP matcher per D14: exact commands STOP, STOP ALL,
   UNSUBSCRIBE, ΔΙΑΚΟΠΗ, ΣΤΟΠ — case-, whitespace- and accent-insensitive
   (Greek accent folding). Pure function, no I/O.
3. A fixtures corpus of Greek conversation transcripts for later extraction
   evals: happy path, multi-message burst, two same-name candidates
   («δύο Κώστες»), mention of a non-candidate name, unrelated chat, safety
   language, STOP mid-flow, staff follow-up after takeover. Store as typed
   test fixtures with expected-outcome annotations.

Definition of done: focused unit tests (matcher edge cases incl. accents and
mixed case), pnpm check green, a short docs note where the plan's docs-impact
rules require it. Do not build any runtime pipeline, queue, or schema — that
is other packages' scope.
```

## WP1 — Stub events slice (backend + plain admin CRUD, M)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/architecture.md, docs/backend.md,
docs/backend/modules/participants.md, then
POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D1, D4, D16, D18), §4 and §8/WP1.

Implement:
1. PostgreSQL tables events and event_attendees per plan §4 (Drizzle schema
   in packages/database + migration). FKs to participants ON DELETE RESTRICT.
   UNIQUE(event_id, participant_id). Corrections are UPDATEs: present flag,
   never row deletion; expose no delete operation for finished events.
2. Nest module (staff-authorized via the existing Clerk boundary): event CRUD,
   status transitions draft→scheduled→finished|cancelled, attendance/table
   editing, audit events on every mutation via the existing audit_events
   pattern.
3. The shared candidate/eligibility helper (D16): one function returning the
   candidates for (eventId, respondentParticipantId) = attendees with
   present=true minus the respondent, with display names. It will be reused
   by extraction AND validation — design it as the single source of that rule.
4. Add post_event_feedback_whatsapp_opt_in boolean (default false) to
   participants (D4) + staff toggle endpoint + audit event; surface the
   toggle in the existing participant admin view.
5. Minimal admin screens for events (list, create/edit, attendance toggles,
   table numbers) using existing Jts* components — plain CRUD, no styling
   ambitions; the flagship UI is a different package.

Definition of done: migrations reviewed and reversible-safe, focused tests
(constraints, helper rule, status transitions), pnpm check green, docs
updated (new module page under docs/backend/modules/ per the documentation
standard). Do not create any feedback_* tables.
```

## WP2 — Feedback persistence (backend, M)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/backend/mechanisms/database.md, then
POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D4, D7, D12, D18), §4 and §8/WP2.
Prerequisites already merged: WP0 (question keys), WP1 (events tables).

Implement the five feedback tables exactly per plan §4: feedback_campaigns
(UNIQUE event_id, questions jsonb copy at launch), feedback_answers (UNIQUE
NULLS NOT DISTINCT (conversation_id, question_key, subject_participant_id),
source_message_ids, extraction_meta), feedback_notes (nullable subject per
D18, note_type, bounded text, status new|dismissed), provider_message_ingress
(UNIQUE(chat_jid, provider_message_id), text nullable per D10),
message_outbox (dedupe_key UNIQUE, status incl. held, delivery columns folded
in — there is no message_deliveries table). All participant/campaign FKs ON
DELETE RESTRICT; nothing references event_attendees rows.

Include Drizzle schema, migrations, repository layer with typed methods the
later pipeline packages will call, and focused constraint tests proving: the
answer-uniqueness rule (incl. NULL subject), ingress dedupe on conflict,
RESTRICT behavior, outbox dedupe_key.

Definition of done: pnpm check green, docs updated (extend the post-event
feedback module page with the persisted contract and note the §9 deltas of
the plan into docs/decisions/0008 and the handover). No queue, webhook or
Mongo work — other packages own those.
```

## WP3 — Mongo conversation schema v2 (backend, M)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/decisions/0007-mongodb-conversation-authority.md,
docs/backend/modules/conversations.md, docs/backend/mechanisms/mongodb.md,
then POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D6, D9, D16), §6 and §8/WP3.

Implement the schema-v2 purpose-specific conversation document per plan §6 in
the existing conversations module, WITHOUT reinterpreting or migrating any
schema-v1 (assistant) documents: v1 and v2 coexist, discriminated by
schemaVersion+purpose. Deterministic _id = uuidv5(campaignId, participantId).
Fields: lifecycle {open|closed + terminal reason}, control {bot|human +
source}, goals, actor-labelled messages with contiguous seq and
providerMessageId/ingressId/outboxId provenance, phoneAtLaunch,
extraction.cursorSeq, needsAttention, remindedAt. No candidate list is
stored (D16).

Repository methods: createFromLaunch (idempotent via deterministic _id),
appendMessage (idempotent by ingressId/outboxId), takeover/resume/close
transitions (STOP-closed conversations can never reopen), advanceCursor,
setNeedsAttention, list projections grouped by campaignId (compact — no full
transcripts in list reads, follow the assistant list precedent).

Indexes: partial unique on phoneAtLaunch where purpose=post_event_feedback
and lifecycle open (D9); campaignId. Message cap ~150 with a byte guard;
hitting the cap sets needsAttention, never silently drops.

Definition of done: Zod validators + focused tests (idempotent append, cap
guard, transition rules, index contracts), pnpm check green,
docs/backend/modules/conversations.md updated. No webhook/queue/extraction
logic.
```

## WP4 — Ingress + materialization (backend, L)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/backend/mechanisms/wasender.md,
docs/backend/mechanisms/queues.md, then
POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D7–D10, D14, D17), §7 and §8/WP4.
Prerequisites merged: WP2, WP3. WP0 provides the STOP matcher.

Implement the durable consumer behind the EXISTING env gates
(WASENDER_WEBHOOK_ENABLED stays default-false):
1. Webhook handler: after the existing signature/normalization edge, do
   exactly one provider_message_ingress INSERT (dedupe via the unique
   constraint), enqueue feedback.materialize.v1(ingressId), return 200.
   Nothing else in-request (D8).
2. feedback queue + materialize processor (idempotent, reloads authoritative
   state, versioned identifier-only payload per the queue mechanism doc):
   resolve phone → open conversation via the Mongo partial index (D9);
   unmatched → mark ignored_unmatched, keep metadata only, never store text,
   increment a metric (D10); STOP check via the WP0 matcher BEFORE any AI —
   on STOP: close(stopped), cancel that conversation's queued outbox rows,
   flip the participant opt-in boolean off, audit, enqueue the single
   stop_ack via outbox (D14); append inbound to the Mongo transcript
   idempotently; participant inbound → enqueue feedback.extract.v1.
3. Outbound observations: correlate to message_outbox (mark delivery
   columns); an outbound with no outbox match → control=human + audit
   (external channel activity), per D17/ADR 0008.

Definition of done: replay/crash tests (duplicate webhook delivery, double
materialize, out-of-order arrival, STOP during human control), pnpm check
green, wasender mechanism doc updated (the controller no longer discards
events). Do not implement extraction, sending, or campaign logic.
```

## WP5 — Extraction + reply loop (backend, L)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/backend/modules/assistant.md (provider registry and
fencing precedents), then POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D3, D5,
D12, D13, D16, D18), §7 and §8/WP5. Prerequisites merged: WP4 (+WP0, WP1).

Implement feedback.extract.v1, serialized per conversation with deterministic
job id feedback-extract-v1-<conversationId>-<latestSeq>:
1. Reload conversation; skip cleanly if closed, control=human, or
   extraction.cursorSeq >= latestSeq.
2. Candidates come from the WP1 shared helper at run time (D16 — live
   select); record the exact candidate IDs, model and confidence in
   extraction_meta on every persisted row (D12).
3. Build the Greek-first prompt: full actor-labelled transcript + campaign
   question snapshot + candidates + already-accepted results + output
   constraints. Call the model through the existing provider registry
   pattern with structured output validated by Zod (default
   google/gemini-3.6-flash, configurable). The model returns a proposal only:
   answers[], notes[], nextGoal, reply, handoff, safetySignal, confidence.
4. Application validation before any persistence or send: source message IDs
   exist in this conversation; only participant messages support
   extractions; question keys and note types are allowed; subject IDs are in
   the current candidate set AND differ from the respondent — an
   unresolvable mentioned name degrades to a subjectless note flagged for
   review, never a guessed subject (D18); replay cannot duplicate (unique
   constraints + cursor); lifecycle/control/opt-in permit a reply.
5. Persist answers/notes, advance cursor, update goals (answered goals are
   never auto-reopened when candidates appear later — D16), enqueue the bot
   reply via message_outbox with dedupe_key conversationId+cursorSeq; when
   all goals are terminal, close(completed) and send the closing copy.
   safetySignal or handoff → needsAttention + audit + neutral handoff, no
   ordinary note (D13).
6. Log estimated token usage per run (tokens, not message count).

Definition of done: an offline eval run against the WP0 fixtures with
expected outcomes asserted (esp. the two-Kostas ambiguity and the unknown
name cases), idempotency tests (same job replayed = no new rows), pnpm check
green, module doc updated. No transport code and no UI.
```

## WP6 — Outbox relay + transport delivery (backend, M)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/backend/mechanisms/queues.md (email outbox relay — your
reference implementation), docs/backend/mechanisms/wasender.md, then
POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D2, D5, D7, D8), §7 and §8/WP6.
Prerequisites merged: WP2 (+WP4 for status wiring).

Implement:
1. An outbox relay for message_outbox following the email relay pattern
   (FOR UPDATE SKIP LOCKED lease, stable job key, recovery horizon). Rows
   with status held are never leased.
2. A transport boundary switched by TRANSPORT_MODE: 'simulated' → write to
   the WP8 sim sink; 'wasender' → WasenderClient.sendText with pacing (a
   minimum interval + jitter per shared session — the session is shared with
   WordPress) and staggered campaign sends.
3. Ambiguous-send handling per the wasender mechanism doc: an unknown-outcome
   send is never blindly retried — reconcile via stored provider IDs/status
   first, then decide.
4. messages.update events (via WP4) update the delivery columns on
   message_outbox. STOP/expiry cancellations flip pending rows to cancelled.

Definition of done: tests for lease/idempotency, pacing bounds, unknown-
outcome no-retry, cancellation; pnpm check green; queue/wasender docs
updated. No campaign or UI logic.
```

## WP7 — Campaign service + schedulers (backend, M)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, then POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D1, D4, D6,
D11, D17), §7 and §8/WP7. Prerequisites merged: WP2–WP6.

Implement the campaign application service + HTTP endpoints (staff-only):
1. Launch: allowed only for status=finished events with at least one
   eligible attendee (present ∧ opt-in ∧ phone_e164). Creates the campaign
   row (question snapshot jsonb, version), one Mongo conversation per
   eligible attendee (deterministic _id — replay-safe), and enqueues
   staggered intro sends through the outbox. Audit everything.
2. Pause / resume-campaign / close (kill switch semantics: pause stops the
   relay from leasing that campaign's rows and extraction from replying).
3. Start-conversation action (D17): create-if-missing for one participant
   (same eligibility gate); never recreates a STOP-closed conversation.
4. Reminder sweep (D11): one reminder at FEEDBACK_REMINDER_AFTER_HOURS=24 if
   no participant reply exists; expiry sweep at FEEDBACK_EXPIRE_AFTER_HOURS=72
   → close(expired) + cancel queued sends. Bounded, idempotent, reload-state
   jobs per the queue mechanism doc.

Definition of done: tests for the eligibility gate, launch idempotency
(replayed launch creates nothing new), reminder/expiry edge cases (opted-out,
human control, already closed), pnpm check green, module doc updated.
```

## WP8 — Dev simulation transport (backend, S/M)

```text
You are working in the JoinTheSix pnpm/turbo monorepo. Read AGENTS.md,
docs/README.md, docs/backend/mechanisms/wasender.md (normalized event
shapes), then POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §2 (D2), §8/WP8 and
§11/U2. Prerequisite: WP4's normalized-event contract (parallelizable).

Implement, strictly dev/staging-gated (TRANSPORT_MODE=simulated, disabled in
production config):
1. The simulated outbound sink: outbox sends are stored as sim messages
   (queryable per phone/conversation) instead of calling Wasender.
2. A dev-only authenticated inject endpoint: given phone + text (+ optional
   fromMe for simulating manual outbound), it produces the SAME normalized
   observed-message event a real webhook would and feeds the same ingress
   path — no parallel code path, no special-case handling downstream.
3. A read endpoint the WP9 dev composer will use to render the sim thread
   per phone.

Definition of done: an integration test running intro → inject reply →
materialize → (stubbed) extract trigger entirely in simulated mode; proof
that production composition cannot mount the injector; pnpm check green;
mechanism note in docs. No UI.
```

## WP9 — Admin conversations UI (frontend, L — route to Opus 5)

```text
You are working in the JoinTheSix pnpm/turbo monorepo (React admin SPA in
apps/admin). Read AGENTS.md (component selection hierarchy),
docs/frontend.md, docs/frontend/theming.md,
docs/frontend/components/README.md, docs/frontend/assistant.md (polling
precedent), then POST_EVENT_FEEDBACK_PLAN_2026-07-25.md §8/WP9 and §11
(U1–U4, D17, D18). Backend contract: WP7 endpoints + WP2/WP3 read models +
WP8 dev endpoints.

Build the conversations experience:
1. U1 three-pane inbox: left = conversations grouped by event/campaign with
   progress, bot/human and needs-attention badges and text filter; center =
   actor-labelled transcript (bot / participant / staff / system visually
   distinct, timestamps, delivery state on outbound); right = details pane
   (goal progress, structured answers, notes with review status, links to
   participant profile, action buttons).
2. Actions with confirmation + optimistic-safe state handling: Take over,
   Staff send (only while in human control; goes through the outbox
   endpoint), Resume bot, Close (reason cancelled), Start conversation
   (event-level, D17), Campaign pause. Respect server-declared capability
   flags (e.g. STOP-closed threads expose no actions).
3. U2: when the backend reports simulated transport, render the dev
   «Reply as {name}» composer in the transcript pane, posting to the WP8
   inject endpoint.
4. U4: per-event Results tab — clean filterable list of all answers/notes
   (question, participant, review status), no charts.
5. U3: TanStack Query polling — ~3–5s on the selected conversation, slower
   on the list, paused when the tab is hidden.
6. D18: defensive «άγνωστος συμμετέχων» fallback wherever a participant ID
   cannot be resolved. Loading/empty/error states per the frontend handbook;
   dark mode via existing tokens; reuse or extend Jts* components before
   reaching for HeroUI primitives, and document any new reusable component.

Definition of done: pnpm check green (typecheck, lint, tests), component
docs updated per the documentation standard, screenshots or Storybook-less
visual notes in the PR description for light and dark themes.
```

---

**Gate pack reminder (no agent, human-owned):** Wasender staging acceptance
tests, consent research/ledger/legal, Meta-BSP classification, safety_reports
table, canary with kill switch — all before any real participant.
