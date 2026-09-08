# Authoring review

2026-09-08. This is fixture review, not an extraction benchmark.

Two Astra agents checked the shared event brief and all participant profiles for
group, seat, device and attendance consistency. Root reviewed the event story and
all ten pilot conversations with their draft findings before bulk generation.

## Pilot corrections carried into the shared prompt

- Removed extra rating questions that exceeded the single-follow-up interview.
- Removed bot knowledge taken from private profiles: an unnamed confusing part
  stays unnamed until the participant identifies it.
- Kept causal uncertainty instead of asking someone to guess why a control was
  hard to find.
- Added the assigned menu-directed profanity; it is not a withdrawal request.
- Changed retrospective lesson feedback to `general`; mentioning an exercise
  does not itself mean `activity_interest`.
- Kept the explicit 6/10 → 8/10 correction without pretending either is an
  accepted 1–5 score.
- Preserved the G08 acquaintance's complaint as qualified hearsay, separate from
  the respondent's own experience.
- Removed a doorway exercise that conflicted with the shared still-life brief.

## Bulk review

Root read all 100 scenarios (395 messages) and their expected findings. Corrections
include an unsupported gender assigned to a neighboring participant, a missing
finding about waiting for help, and a bot follow-up that assumed an experienced
attendee wanted more instruction on basic editing. A narrow handout request was
made explicit about educational materials so it cannot silently teach the
extractor to ignore an ambiguous contact preference.

The invitation text is deliberately reusable. Human replies include brief and
unfinished messages, mixed language, hearsay, qualified complaints, revisions and
refusals. This is a designed coverage set, not a random sample of real attendees;
repeated archetypes and the outcome proportions do not estimate human behavior.

Structural checks validate all source references, chronology, outcomes and
PostgreSQL message serialization. Expected findings remain marked `draft`:
reading generated dialogue is not evidence that the real extractor matches it.
Further semantic evaluation must compare actual extraction with reviewed evidence
and record disagreements rather than silently accepting an author model's answer.
