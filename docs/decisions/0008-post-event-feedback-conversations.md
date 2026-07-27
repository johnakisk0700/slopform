# ADR 0008: Post-event feedback conversations

- Status: Accepted; implemented and amended
- Date: 2026-07-25
- Amended: 2026-07-26
- Scope: WhatsApp post-event feedback only. Provider activation remains gated
  by consent, policy/legal approval and the durable ingress/outbox work named
  below.

## Amendments

The implementation acceptance runs superseded two original assumptions without
rewriting the historical decision below:

- candidate IDs are selected live from current attendance at each extraction
  (D16), rather than frozen at campaign launch;
- safety-flavoured testimony remains an ordinary answer/note with provenance
  (D13 amended). It additionally raises `needsAttention` and attaches bounded
  attention metadata to the cited participant message. A separately authorized
  `SafetyReport` remains deferred.

The attention metadata uses closed enums: category
(`sexual_misconduct | harassment | violence_or_threat | self_harm |
other_safety`), recommended action (`review | human_follow_up |
urgent_human_follow_up`) and model confidence. An independent structured model
call classifies only new participant message IDs, using the six preceding
messages plus the new burst as context. The main extraction call does not
select attention categories or actions, and there is no keyword classifier.
Frontend copy, icons and colour are fixed application mappings. A terminal
provider failure raises generic conversation attention but does not invent a
message category.

## Decision

Model post-event collection as one `FeedbackCampaign` per completed event and
one `FeedbackConversation` per eligible respondent in that campaign.

Campaign launch snapshots the locked attendance and table membership. A
conversation may refer only to that snapshot: the respondent is excluded from
their own candidates, absent participants are excluded, and a later table edit
does not silently rewrite a live questionnaire.

Keep the existing narrow authority split:

| Authority  | Owns                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| MongoDB    | Full ordered transcript, typed actor, goals, lifecycle and takeover                                             |
| PostgreSQL | Campaign, eligibility snapshot, structured answers/notes, consent, audit, provider ingress, outbox and delivery |
| Redis      | Short-lived processing, extraction, reminder and delivery jobs only                                             |
| Wasender   | Transport identifiers and observations; never conversation history                                              |

The PostgreSQL business result is directional. Every person-specific
`FeedbackAnswer` or `FeedbackNote` records:

- the campaign and conversation;
- `respondentParticipantId`, meaning who said it;
- nullable `subjectParticipantId`, meaning who it was about;
- its question or bounded note type and structured value/text;
- the Mongo message IDs that support the extraction.

`respondent -> subject` is not interchangeable with `subject -> respondent`.
Event-wide answers may omit the subject. Safety or harassment content is not an
ordinary note; it enters a separately authorized `SafetyReport` flow.

Questions are versioned definitions. Campaign launch snapshots the selected
question keys/prompts and allowed candidate IDs so a live conversation does not
change when definitions or assignments change.

## Conversation and human control

The product semantics have two orthogonal dimensions:

- lifecycle: `open` or `closed`, with a terminal reason only when closed;
- control: `bot` or `human`.

The exact persisted enum shape may be introduced by a versioned Mongo schema
change. Queue, delivery and extraction statuses do not become conversation
states merely because they exist.

Staff normally take over explicitly before sending. While human control is
active, automated replies are forbidden. An outbound Wasender observation that
cannot be correlated to the PostgreSQL outbox is treated as external channel
activity: the conversation moves to human control and records an audit event.
This rule does not guess which staff member sent it; it prevents two writers
from speaking concurrently. Resuming bot control is explicit.

STOP and equivalent opt-out commands are deterministic channel commands. They
remain effective during human control and cannot be overridden by an AI
classification or a later resume.

## AI context and extraction

The first implementation supplies the model with:

- the actor-labelled transcript;
- current goals and already accepted answers;
- the campaign's versioned questions and candidate snapshot;
- explicit extraction and reply constraints.

The model returns a structured proposal: answers, side notes, next goal,
suggested reply, confidence and any handoff/safety signal. Application code
validates participant IDs, question/note types, provenance, consent and current
control before persisting or sending anything. The model does not mutate the
database or call Wasender directly.

Full transcript input is the initial strategy because these conversations are
expected to be short and staff messages may contain useful follow-up questions.
Cost and context pressure are measured in tokens, not message count. No
`Segment` entity, automatic history exclusion or summarization layer is part of
the initial contract.

An extraction cursor or equivalent idempotency boundary must prevent the same
source messages from materializing duplicate answers/notes while still allowing
the full prior transcript to be supplied as context. The physical representation
is left to the implementation design.

## Execution boundary

A conversation is a durable aggregate, not a BullMQ job that remains active
while waiting for a participant. Webhook handling, message coalescing, AI
extraction, reminders and sends use bounded jobs that reload authoritative state
before acting.

Provider message IDs are deduplicated. Known outbounds correlate to an outbox
record; unknown outbounds trigger human control. Delivery status belongs to the
message/delivery record, not the conversation lifecycle.

The v1 design assumes that Wasender `messages.upsert` observes manual outbound
messages sent from the primary WhatsApp application or another linked client.
Wasender documents the event as covering all incoming and outgoing session
messages but does not explicitly guarantee each linked-client source. This is a
staging acceptance assumption, not a verified provider contract. Failure of the
acceptance test changes the operating model to application-only staff sends or
another explicit single-writer rule; it must not be papered over with AI
inference.

Before enabling the webhook, implementation must document and test one recovery
direction for:

1. durable webhook acknowledgement and deduplication;
2. PostgreSQL ingress to Mongo transcript materialization;
3. Mongo extraction to PostgreSQL answers/notes and reply outbox;
4. crashes between either store and Redis.

There is no distributed transaction. The design must use durable identifiers,
idempotency constraints and replay/repair rather than claiming exactly-once
processing.

## Consequences

- Event and participant screens query the same directional rows instead of
  copying notes into campaign, conversation and participant records.
- A participant profile can show feedback given
  (`respondentParticipantId = profile`) and restricted feedback received
  (`subjectParticipantId = profile`), grouped by event.
- The admin campaign view can group the same records by campaign and respondent,
  and source links can open the supporting Mongo transcript.
- Human intervention remains part of one conversation and can contribute useful
  participant answers; staff text itself is never extracted as participant
  testimony.
- The existing generic conversation schema already supports
  `post_event_feedback`, goals and takeover, but its exact v1 state/takeover
  representation is not declared to be the final feedback product contract.

## Amendments

**2026-07-25, conversation persistence (WP3).** The simplification pass
recorded in the
[implementation plan](../history/post-event-feedback-plan-2026-07-25.md) narrowed
three points of this decision. The original text above stands as the accepted
architecture; these are its current consequences:

- The persisted conversation shape is now MongoDB **schema v2**: product
  lifecycle `open | closed` with a terminal reason and orthogonal control
  `bot | human` with a change source, replacing the schema-v1 `state` and
  `humanTakeover` enums for this purpose. Schema v1 is untouched and keeps
  serving the Assistant.
- The PostgreSQL campaign-recipient projection is **not created**. The
  conversation document carries the recipient's phone at launch and its own
  state, a partial unique index makes inbound phone resolution unambiguous, and
  the admin list reads compact Mongo projections.
- Launch snapshots only the **question set and its copy**. Candidates are
  selected live at extraction time from current attendance instead of a frozen
  candidate snapshot, each run records the candidate IDs it used, and answered
  goals are never auto-reopened.

The extraction idempotency boundary this decision left open is now the
document's monotonic `extraction.cursorSeq`.

## Deliberately open experiments

The following require measured conversation fixtures before another decision:

- token warning and hard context thresholds;
- when, if ever, older transcript summarization is useful;
- whether quiet-window coalescing improves multi-message bursts;
- whether explicit segments or context windows improve extraction;
- linked-client/manual outbound observation and webhook retry behavior;
- the smallest useful side-note taxonomy and confidence/review policy;
- reminder cadence, expiry and campaign completion policy.

## Rejected alternatives

### Wasender logs as conversation authority

Provider logs are incomplete and configuration-dependent. They cannot own
retention, participant identity, admin interventions or structured feedback.

### Notes copied onto participants and campaigns

Copies drift and erase who said what about whom. Directional rows with campaign,
respondent, subject and provenance serve both views without dual authority.

### One long-running job per participant

Waiting for WhatsApp replies is durable workflow state, not active compute.
Long-lived jobs make deployment, retry and recovery semantics worse without
adding product value.

### AI-owned state transitions

Model output is untrusted extraction. Letting it directly mutate goals, consent,
takeover or delivery state would bypass domain validation and audit.

## References

- [Post-event feedback module contract](../backend/modules/post-event-feedback.md)
- [Conversation aggregate](../backend/modules/conversations.md)
- [Wasender transport boundary](../backend/mechanisms/wasender.md)
- [Queue and outbox boundary](../backend/mechanisms/queues.md)
- [ADR 0007: MongoDB conversation authority](0007-mongodb-conversation-authority.md)
