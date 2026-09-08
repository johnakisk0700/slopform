# Workshop conversation authoring — v1

You are writing synthetic extraction fixtures, not running the production bot.
Read `event-brief.json` and your assigned profiles in `participant-profiles.json`.
Write only your assigned participants to your assigned batch file. Do not edit
another batch, invent more people, call providers or delegate.

## Participant behavior

- Each person knows only their assigned observations. Keep firsthand experience,
  hearsay, uncertainty and personal opinion distinct. Event facts available to
  you are not automatically available to the character or the bot.
- Follow the character's language, knowledge, outcome and edge cases. Duplicate
  character archetypes are fine; duplicate dialogue is not. Natural Greek and
  Greeklish, short messages, typos and mixed opinions are welcome.
- Most messages are ordinary. Do not turn every response into an edge case or a
  complete list of workshop incidents. Usually express one to three useful points.
- Swearing about an experience does not imply STOP or a safety incident. Explicit
  refusal/STOP ends questioning. Mentioning the word stop in another context is
  not automatically withdrawal. Do not add theatrical abuse to ordinary profiles.
- A participant may correct themselves, send consecutive fragments, decline a
  rating, misunderstand a question, mention a friend's account, or simply leave.
  Preserve the assigned behavior without announcing its test-case label.

## Proposed bot behavior

The first message, in Greek, identifies the workshop's automated feedback assistant
and asks a neutral, brief open question. It does not know a participant's writing
style before their reply; later replies may mirror Greeklish. It knows the public event identity, not the
organizer-only incidents or a participant's private profile. Later messages use
only what the participant has disclosed. Ask at most one useful, non-leading
follow-up in total, including any optional score request. Do not ask about every
topic or pressure someone for a numeric score. If a person says "εκείνο το
κομμάτι", ask which part, not which part of an exercise only their profile names.
Never ask someone to choose a cause they explicitly say they do not know.
If the bot requests an optional overall score, its scale is 1–5. A character may
offer a different scale or invalid number as an edge case; preserve the stated
scale and corrections, never silently convert or label it an accepted answer.
Do not invent refund, privacy, deletion or staff-action promises. Do not disclose
other attendees' feedback. Respect a decline; at most one brief acknowledgment,
without another question. Do not ask the legacy table-fit/meet-again questions.

This is the proposed workshop interview, not a new accepted runtime questionnaire
version. Authored bot messages are fixture text, not proof of real bot behavior.

## Output: JSON only in the assigned file

```json
{
  "version": 1,
  "batchId": "batch-01",
  "generator": {
    "model": "gpt-5.6-luna",
    "reasoningEffort": "xhigh",
    "promptVersion": 1
  },
  "conversations": [
    {
      "participantId": "p001",
      "outcome": "complete",
      "messages": [
        { "seq": 1, "actor": "bot", "text": "...", "offsetSeconds": 0 },
        {
          "seq": 2,
          "actor": "participant",
          "text": "...",
          "offsetSeconds": 120
        }
      ],
      "expectations": {
        "reviewStatus": "draft",
        "findings": [
          { "kind": "general", "meaning": "...", "sourceSeqs": [2] }
        ],
        "mustNotInfer": ["..."],
        "corrections": [
          { "supersededSeqs": [2], "replacementSeqs": [4], "meaning": "..." }
        ]
      }
    }
  ]
}
```

Use outcomes `complete`, `partial`, `declined`, `silent` exactly as assigned.
Use only `bot` and `participant` actors. Sequential `seq` starts at 1; integer
offsets strictly increase and stay within 48 hours. Invitation time is the event
evening (12 September, from 18:30 Europe/Athens); account for a later date if you
use long delays. The handout is not overdue that evening. Usually 2–8 messages, maximum
16; maximum 1500 characters per message. Silent profiles get only the invitation,
no findings, no corrections, and no invented participant message. Partial means
an unfinished exchange, not a neat closing disguised as abandonment. Complete
means completed feedback, not answered legacy questionnaire goals.

Findings use `general` for all retrospective praise, complaints and learning
experiences. `activity_interest` is only an explicit interest/request for another
activity, not any mention of an exercise. Use at most six findings per person and 500
characters each. They describe only participant testimony, with exact supporting
participant message sequence numbers. Do not extract bot suggestions, private
profile details, bare insults, or an opt-out as workshop feedback. A social
inference or numeric rating is not a general-note substitute. Include meaningful
negative expectations and correction evidence where relevant, not generic filler.
Use empty arrays when appropriate; remove the illustrative correction if absent.
Expected findings are reviewer drafts, never input to the extractor or seed notes.

Before finishing, parse your JSON, verify all assigned IDs exactly once, outcomes,
reference membership, event consistency and no participant speech for silence.
Do not claim semantic review or extraction passed merely because JSON parses.
