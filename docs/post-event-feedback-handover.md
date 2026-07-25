# Handover: WhatsApp post-event feedback

Snapshot date: **2026-07-25**

This is a self-contained handover for continuing the design or implementation
in another chat. The canonical repository decisions are
[ADR 0008](decisions/0008-post-event-feedback-conversations.md), the
[post-event feedback module contract](backend/modules/post-event-feedback.md),
the [conversation aggregate](backend/modules/conversations.md) and the
[Wasender boundary](backend/mechanisms/wasender.md). If this snapshot later
disagrees with code or those maintained documents, reconcile the discrepancy
instead of preserving this handover as historical fiction.

## Goal

After an event, collect small amounts of structured feedback from each attendee
through a short WhatsApp conversation. The flow should:

- ask versioned questions about the event and the other attendees at the same
  table;
- accept natural, multi-message answers rather than force a rigid form;
- extract normalized answers, scores and useful side notes;
- preserve the full actor-labelled transcript;
- allow staff to take over and later resume the bot;
- stop immediately on opt-out;
- expose the same feedback from both event and participant admin views;
- keep ordinary feedback separate from confidential safety reports.

This is not intended to become a generic customer-support inbox in v1.

## Current repository reality

### Implemented

- `WasenderClient` can send text, get information for a known provider log ID
  and mark an exact message key as read.
- A signed webhook edge parses:
  - `messages.upsert`;
  - `messages-personal.received`;
  - `messages.update`.
- `messages.upsert` is normalized into an observed message with provider
  message ID, timestamp, direction, chat JID, optional phone and optional text.
- MongoDB already owns generic conversation aggregates with purpose
  `post_event_feedback`, ordered goals, turns and takeover fields.
- PostgreSQL, BullMQ and transactional-outbox patterns already exist elsewhere
  in the backend.

### Not implemented

- The Wasender webhook is disabled by default.
- The current controller validates and normalizes an event, returns `200`, and
  discards it. There is no durable message consumer.
- There are no feedback campaign, recipient, answer or note tables.
- There is no event-bound participant/candidate snapshot.
- There is no WhatsApp feedback worker, AI extractor, staff inbox or feedback
  campaign UI.
- The existing Mongo conversation v1 schema models AI-style input/output turns.
  It may need a versioned purpose-specific message representation for arbitrary
  WhatsApp ordering such as:

  ```text
  bot → participant → participant → admin → participant → bot
  ```

## Wasender findings and operating assumption

### Confirmed from public documentation

- `messages.upsert` is documented as observing all incoming and outgoing
  messages in a Wasender session.
- Wasender has no documented endpoint equivalent to
  `getChatMessages(chatJid, limit)`.
- `GET /api/whatsapp-sessions/{session}/message-logs` is paginated but contains
  messages sent through the Wasender API only.
- Message-log `content` and `to` may be `null` when session message logging is
  disabled.
- `GET /api/messages/{msgId}/info` retrieves one known API message; it is not
  conversation-history search.
- Therefore full history begins only when our durable webhook consumer begins
  storing events. Provider logs may be used only as explicitly partial outbound
  backfill.

Official references:

- <https://wasenderapi.com/api-docs/webhooks/webhook-message-upsert>
- <https://www.wasenderapi.com/api-docs/sessions/get-message-logs>
- <https://wasenderapi.com/api-docs/messages/get-message-info>
- <https://www.wasenderapi.com/help/messaging/using-webhooks>

### Accepted but unverified v1 assumption

Assume `messages.upsert` also observes manual outbound messages sent from the
primary WhatsApp application or WhatsApp Web/another linked client.

Wasender says “all incoming and outgoing session messages” but does not
explicitly name each linked-client source. The repository has parser tests for
`fromMe=true`; those tests prove our parser, not provider behavior.

Before activation, staging must send from:

1. the primary business phone;
2. WhatsApp Web or another linked device;
3. our backend API.

It must compare payloads, IDs, duplication and latency. It must also test a
failed webhook response to determine whether Wasender retries. No documented
provider replay/retry guarantee was found.

If the linked-client assumption fails, staff sends during an active feedback
conversation must be application-only or follow another explicit single-writer
rule. AI inference is not an acceptable substitute.

## Accepted domain model

### Campaign and conversation

- One `FeedbackCampaign` per completed event.
- One `FeedbackConversation` per eligible respondent in the campaign.
- Staff launches the campaign only after event completion and locked
  attendance.
- Launch snapshots:
  - attendees marked present;
  - table membership;
  - eligible candidates for every respondent;
  - the versioned question set.
- A respondent cannot be their own subject.
- Absent participants are not candidates.
- Later table edits do not rewrite a live questionnaire.

### Directed feedback

Person-specific feedback is a directed relationship:

```text
respondentParticipantId --said about--> subjectParticipantId
```

Example:

```text
Roula says: “Kostas was great; I would go skiing with him.”
```

The resulting business data means:

```text
respondent = Roula
subject = Kostas
```

It does not mean “Kostas likes skiing.” Reversing the IDs changes the meaning.

The opposite comment is a separate row:

```text
respondent = Kostas
subject = Roula
```

### Structured results

`FeedbackAnswer` stores normalized questionnaire results. Candidate initial
questions are:

```text
event_score → score such as 1–5
liked       → zero or more participant IDs
meet_again  → zero or more participant IDs
avoid       → zero or more participant IDs
```

The exact copy, required/optional rules and score types are not yet locked.

`FeedbackNote` stores a bounded useful side note with respondent, optional
subject and source-message provenance. Example:

```text
type: activity_interest
respondent: Roula
subject: Kostas
text: “Would like to go skiing with Kostas”
```

Do not copy notes onto campaign and participant documents. Store them once and
query them from different views.

Safety, harassment or “I felt unsafe” content is not an ordinary note. It must
enter a separately authorized `SafetyReport` flow with stricter access and
retention.

## Storage authority

| Store      | Authority                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------- |
| MongoDB    | Full ordered transcript, typed actors, goals, lifecycle and takeover                        |
| PostgreSQL | Campaign, snapshots, structured answers/notes, consent, audit, ingress, outbox and delivery |
| Redis      | Disposable coordination and bounded jobs                                                    |
| Wasender   | Transport only; never the conversation source of truth                                      |

There is no cross-store transaction. Activation is blocked until implementation
defines and tests one recovery direction for:

1. webhook acknowledgement and provider-ID deduplication;
2. PostgreSQL ingress to Mongo transcript materialization;
3. Mongo extraction to PostgreSQL answers/notes and reply outbox;
4. crashes between either database and Redis;
5. ambiguous outbound sends.

### Candidate PostgreSQL records

```text
feedback_campaigns
feedback_campaign_recipients
feedback_candidate_snapshots
feedback_answers
feedback_notes
provider_message_ingress
message_outbox
message_deliveries
audit_events
```

A person-specific answer/note needs:

```text
campaign_id
conversation_id
respondent_participant_id
subject_participant_id
question_key or note_type
structured value/text
source_message_ids
extraction metadata
timestamps
```

General event scores may have no subject.

### Candidate Mongo conversation shape

The exact schema requires a versioned design. Product semantics need:

```text
conversation ID
campaign ID
respondent participant ID
open/closed lifecycle
bot/human control
ordered goals/current goal
ordered actor-labelled messages
provider IDs and timestamps needed for provenance
AI execution/extraction metadata where required
```

Do not silently reinterpret existing schema-v1 documents.

## Conversation control

Keep product state small and orthogonal:

```text
lifecycle = open | closed
control   = bot | human
```

A terminal reason exists only when closed, for example:

```text
completed | stopped | expired | cancelled
```

Queue, processing and delivery statuses belong to their own records. They are
not conversation states.

### Explicit takeover

The normal staff workflow is:

1. staff presses `Take over`;
2. control changes to `human`;
3. the staff send is accepted;
4. bot jobs reload state and are forbidden from sending while human control is
   active;
5. staff presses `Resume bot` when finished.

### Manual WhatsApp outbound

If an outbound `messages.upsert` cannot be correlated to our PostgreSQL outbox,
treat it as external channel activity:

```text
open/bot → open/human
```

Store it in the transcript and audit the takeover. Do not guess which staff
member sent it.

### Resume

The current initial strategy is to preserve and provide the actor-labelled
human exchange to AI, because the admin may have asked useful follow-up
questions and the participant may have provided valid feedback.

Only participant statements may materialize as participant answers or notes.
Admin and bot statements provide context, not testimony.

### STOP

STOP and equivalent opt-out phrases are deterministic commands. They remain
active in bot and human control, close the conversation and prevent later
resume. AI does not decide whether an explicit opt-out counts.

## AI strategy

### Initial input

Supply:

- full actor-labelled transcript;
- versioned questions;
- allowed candidates from the frozen table snapshot;
- current goals and already accepted structured results;
- extraction, safety, handoff and reply constraints.

### Required output

The model returns a proposal, not side effects:

```json
{
  "answers": [],
  "notes": [],
  "nextGoal": "question-key",
  "reply": "suggested WhatsApp response",
  "handoff": false,
  "safetySignal": null,
  "confidence": 0.9
}
```

Application code validates:

- source message IDs exist;
- participant statements, not staff text, support the extraction;
- question and note types are allowed;
- subject IDs belong to the frozen candidate set;
- respondent and subject differ;
- replay cannot duplicate structured results;
- lifecycle, control and consent permit a reply.

The model does not mutate the database and does not call Wasender directly.

### Context and idempotency

Full transcript is the initial context strategy. Twenty short messages are not
equivalent to two essays, so warnings and limits must use estimated tokens, not
message count.

An extraction cursor or equivalent idempotency boundary must prevent old source
messages from producing duplicate answers/notes while still allowing the full
history to be supplied as context.

Do not add segments, automatic history exclusion or summarization in v1.
Introduce them only if measured fixtures show context cost or extraction
quality problems.

### Multi-message bursts

Every provider message is stored immediately. Whether to add a short quiet
window to combine two or three rapid participant messages before replying is an
open experiment. If implemented, it needs:

- deterministic job IDs;
- a bounded maximum wait;
- serialization per conversation;
- reloading lifecycle/control before sending;
- duplicate message protection.

## Admin views

### Event campaign

Show one row per respondent:

```text
participant
progress
bot/human control
answers
notes
last activity
attention required
```

The row opens the full transcript and links to the participant profile.

### Participant profile

Provide restricted staff views:

- events attended;
- feedback given:
  `respondentParticipantId = profile participant`;
- feedback received:
  `subjectParticipantId = profile participant`;
- results grouped by event with links back to campaign, respondent and source
  conversation.

Feedback received, avoidance, negative notes and source identities are not
participant-visible by default.

## Execution model

A conversation is durable workflow state, not a long-running BullMQ job.

Use short jobs for:

- inbound processing;
- optional burst coalescing;
- AI extraction;
- outbound delivery;
- reminders;
- expiry and recovery.

Each job carries identifiers only, reloads authoritative state and tolerates
retry. Redis is never the business source of truth.

## Implementation sequence

### Phase 1: lock the product contract

- exact question wording and answer types;
- required, optional and skip behavior;
- consent and STOP copy;
- useful side-note boundary;
- safety escalation and visibility;
- campaign launch, expiry and reminder policy.

### Phase 2: persistence design

- PostgreSQL schema and constraints;
- Mongo schema v2 or another explicit purpose-specific representation;
- participant/campaign/conversation ID links;
- source-message provenance;
- cross-store recovery direction.

### Phase 3: durable messaging

- PostgreSQL provider ingress and deduplication;
- Mongo transcript materialization;
- PostgreSQL reply outbox and delivery records;
- unknown outbound takeover;
- webhook remains disabled until recovery tests pass.

### Phase 4: deterministic end-to-end flow

Implement campaign launch, frozen candidates, first question, inbound storage,
explicit takeover/resume, STOP and completion without relying on AI extraction.

### Phase 5: AI extraction

Add full-transcript structured extraction, application validation, answers,
notes, safety signals, source provenance, token measurement and evaluation
fixtures.

### Phase 6: admin UI

Add event campaign rows, conversation drawer, takeover/resume/close actions,
answer/note correction and participant profile given/received views.

### Phase 7: staging and canary

Test:

- primary-phone and WhatsApp Web manual outbound;
- API outbound correlation;
- duplicate and out-of-order webhooks;
- failed webhook retry behavior;
- session disconnect;
- ambiguous send recovery;
- multi-message bursts;
- long human takeover and resume;
- STOP during takeover;
- unrelated and safety content;
- permissions, consent and privacy.

Activate for one canary event with a kill switch and close monitoring.

## Explicit v1 non-goals

- generic support inbox;
- historical WhatsApp backfill;
- media, voice-note and document understanding;
- segments;
- automatic transcript summarization;
- autonomous AI database or Wasender tool calls;
- automatic campaign launch without staff confirmation;
- participant-visible feedback received;
- elaborate note taxonomy;
- microservices, event sourcing or long-running workflow jobs.

## Open decisions and experiments

- final questionnaire copy and answer types;
- note types, confidence and review policy;
- token warning and hard context thresholds;
- whether older-history summaries are ever useful;
- whether rapid-message quiet-window coalescing helps;
- whether segments become useful after measured failures;
- reminder cadence, expiry and campaign completion;
- exact Mongo schema evolution;
- exact PostgreSQL/Mongo recovery protocol;
- linked-client/manual outbound behavior;
- provider webhook retry/replay behavior;
- policy/legal approval and final WhatsApp consent wording.

## Recommended next action

Lock the question set, answer types, side-note boundary and safety/privacy rules.
That is the minimum input required to design PostgreSQL constraints and Mongo
goals without inventing product semantics in migrations.
