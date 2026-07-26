import { describe, expect, it } from "vitest";

import { validateFeedbackExtractionProposal } from "./extraction/validate-proposal.js";
import {
  feedbackExtractionProposalSchema,
  type FeedbackExtractionContext,
  type FeedbackExtractionProposal,
} from "./extraction/extraction.schemas.js";

const respondent = "p-respondent";
const nikos = "p-nikos";
const eleni = "p-eleni";

function context(
  overrides: Partial<FeedbackExtractionContext> = {},
): FeedbackExtractionContext {
  return {
    respondentParticipantId: respondent,
    respondentDisplayName: "Μαρία",
    candidates: [
      { participantId: nikos, displayName: "Νίκος" },
      { participantId: eleni, displayName: "Ελένη" },
    ],
    messages: [
      {
        id: "m1",
        seq: 1,
        actor: "bot",
        occurredAt: "2026-07-25T18:00:00.000Z",
        text: "Πώς σου φάνηκε η βραδιά;",
      },
      {
        id: "m2",
        seq: 2,
        actor: "participant",
        occurredAt: "2026-07-27T18:00:00.000Z",
        text: "5, τέλεια!",
      },
      {
        id: "m3",
        seq: 3,
        actor: "staff",
        occurredAt: "2026-07-27T18:01:00.000Z",
        text: "Χαιρόμαστε πολύ.",
      },
    ],
    newParticipantMessageIds: ["m2"],
    goals: [
      { key: "event_score", ordinal: 1, prompt: "score;", status: "asked" },
      { key: "liked", ordinal: 2, prompt: "liked;", status: "pending" },
      { key: "meet_again", ordinal: 3, prompt: "meet;", status: "pending" },
      { key: "avoid", ordinal: 4, prompt: "avoid;", status: "pending" },
    ],
    acceptedAnswers: [],
    acceptedNotes: [],
    replyAllowed: true,
    ...overrides,
  };
}

function proposal(
  overrides: Partial<FeedbackExtractionProposal> = {},
): FeedbackExtractionProposal {
  return feedbackExtractionProposalSchema.parse({
    answers: [],
    notes: [],
    skippedGoals: [],
    nextGoal: null,
    reply: null,
    handoff: false,
    confidence: 0.9,
    ...overrides,
  });
}

function answer(
  overrides: Partial<FeedbackExtractionProposal["answers"][number]> = {},
): FeedbackExtractionProposal["answers"][number] {
  return {
    questionKey: "liked",
    valueInt: null,
    subjectParticipantId: nikos,
    subjectMentionedName: null,
    sourceMessageIds: ["m2"],
    confidence: 0.9,
    ...overrides,
  };
}

function note(
  overrides: Partial<FeedbackExtractionProposal["notes"][number]> = {},
): FeedbackExtractionProposal["notes"][number] {
  return {
    noteType: "general",
    text: "Ωραία βραδιά.",
    subjectParticipantId: null,
    subjectMentionedName: null,
    sourceMessageIds: ["m2"],
    confidence: 0.7,
    ...overrides,
  };
}

describe("validateFeedbackExtractionProposal", () => {
  describe("provenance", () => {
    it("rejects a source message that is not in this conversation", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ sourceMessageIds: ["m99"] })] }),
        context(),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("unknown_source_message");
    });

    it("rejects a bot message as the source of participant feedback", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ sourceMessageIds: ["m1"] })] }),
        context(),
      );

      expect(result.rejections[0]?.reason).toBe("non_participant_source");
    });

    it("rejects a mixed batch where only one source is invalid", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ sourceMessageIds: ["m2", "m3"] })] }),
        context(),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("non_participant_source");
    });

    it("deduplicates repeated source ids without rejecting them", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ sourceMessageIds: ["m2", "m2"] })] }),
        context(),
      );

      expect(result.answers[0]?.sourceMessageIds).toEqual(["m2"]);
    });

    it("accepts a thought split across a cursor boundary", () => {
      // WhatsApp is typed: «τον Νίκο τον βρήκα» / «πολύ καλό, 5» is one
      // ordinary thought that happens to land in two windows. The run carrying
      // the score cites both halves because that is where the score came from,
      // and demanding that every citation be new used to throw the answer away
      // — while the same answer citing only the second half passed.
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ sourceMessageIds: ["m2", "m4"] })] }),
        context({
          messages: [
            {
              id: "m1",
              seq: 1,
              actor: "bot",
              occurredAt: "2026-07-25T18:00:00.000Z",
              text: "Πώς σου φάνηκε η βραδιά;",
            },
            {
              id: "m2",
              seq: 2,
              actor: "participant",
              occurredAt: "2026-07-25T18:01:00.000Z",
              text: "τον Νίκο τον βρήκα",
            },
            {
              id: "m4",
              seq: 3,
              actor: "participant",
              occurredAt: "2026-07-25T18:02:00.000Z",
              text: "πολύ καλό, 5",
            },
          ],
          newParticipantMessageIds: ["m4"],
        }),
      );

      expect(result.rejections).toEqual([]);
      // The older half stays on the row, so an operator reads the whole thought
      // rather than its second half.
      expect(result.answers[0]?.sourceMessageIds).toEqual(["m2", "m4"]);
    });

    it("still rejects a batch that cites only settled testimony", () => {
      // The rule's real job survives: no result may be born without new
      // testimony driving it, so a run cannot re-mine the old transcript.
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ sourceMessageIds: ["m2"] })] }),
        context({ newParticipantMessageIds: [] }),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("stale_source_message");
    });
  });

  describe("subject resolution", () => {
    it("rejects the respondent as their own subject", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ subjectParticipantId: respondent })] }),
        context(),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("subject_is_respondent");
    });

    it("rejects a subject who is no longer a live candidate", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ subjectParticipantId: nikos })] }),
        // D16 is a live select: Νίκος was marked absent after the fact.
        context({
          candidates: [{ participantId: eleni, displayName: "Ελένη" }],
        }),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("unresolved_subject");
    });

    it("rejects a directed answer with no subject at all", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ subjectParticipantId: null })] }),
        context(),
      );

      expect(result.rejections[0]?.reason).toBe("missing_subject");
    });

    it("keeps a note about the respondent themselves subjectless, without flagging it", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          notes: [
            note({
              subjectParticipantId: respondent,
              subjectMentionedName: "εγώ",
            }),
          ],
        }),
        context(),
      );

      // No directed row may be written about the respondent, so it degrades —
      // but talking about yourself is not a failure to find anybody, and
      // flagging it sent an operator hunting for a person already on screen.
      expect(result.notes[0]).toMatchObject({
        subjectParticipantId: null,
        flaggedForReview: false,
        unresolvedSubjectName: null,
      });
    });

    it("recognises the respondent by name, not only by id", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          notes: [
            note({
              subjectParticipantId: null,
              subjectMentionedName: "η Μαρία",
            }),
          ],
        }),
        context(),
      );

      expect(result.notes[0]).toMatchObject({
        subjectParticipantId: null,
        flaggedForReview: false,
      });
    });

    it("keeps a genuinely subjectless note unflagged", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ notes: [note()] }),
        context(),
      );

      expect(result.notes[0]).toMatchObject({
        subjectParticipantId: null,
        flaggedForReview: false,
        unresolvedSubjectName: null,
      });
    });
  });

  describe("question shape", () => {
    it("rejects a subject on the subjectless event score", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [
            answer({
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: nikos,
            }),
          ],
        }),
        context(),
      );

      expect(result.rejections[0]?.reason).toBe(
        "subject_on_subjectless_question",
      );
    });

    it.each([0, 6, -1])("rejects an out-of-range score of %i", (score) => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [
            answer({
              questionKey: "event_score",
              valueInt: score,
              subjectParticipantId: null,
            }),
          ],
        }),
        context(),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("invalid_score");
    });

    it("rejects a missing score rather than storing a null answer", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [
            answer({
              questionKey: "event_score",
              valueInt: null,
              subjectParticipantId: null,
            }),
          ],
        }),
        context(),
      );

      expect(result.rejections[0]?.reason).toBe("invalid_score");
    });

    it("drops a value proposed on a directed question", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer({ valueInt: 3 })] }),
        context(),
      );

      expect(result.answers[0]?.valueInt).toBeNull();
    });
  });

  describe("replay and duplication", () => {
    it("does not repeat an answer already recorded for this conversation", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer()] }),
        context({
          acceptedAnswers: [
            {
              questionKey: "liked",
              subjectParticipantId: nikos,
              valueInt: null,
            },
          ],
        }),
      );

      expect(result.answers).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("already_recorded");
      expect(result.conflictingAnswerRevision).toBe(false);
    });

    it("accepts a revision when the stored score differs, and still flags it", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [
            answer({
              questionKey: "event_score",
              valueInt: 2,
              subjectParticipantId: null,
            }),
          ],
        }),
        context({
          acceptedAnswers: [
            {
              questionKey: "event_score",
              subjectParticipantId: null,
              valueInt: 4,
            },
          ],
        }),
      );

      // The newest reading wins: saying it again is how somebody revises. The
      // flag stays, because a change of mind is still worth a human's eye —
      // it is no longer the only trace that the answer was ever different.
      expect(result.answers).toMatchObject([
        { questionKey: "event_score", valueInt: 2 },
      ]);
      expect(result.rejections).toEqual([]);
      expect(result.conflictingAnswerRevision).toBe(true);
    });

    it("stays quiet when a replay proposes the same already-recorded value", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [
            answer({
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: null,
            }),
          ],
        }),
        context({
          acceptedAnswers: [
            {
              questionKey: "event_score",
              subjectParticipantId: null,
              valueInt: 4,
            },
          ],
        }),
      );

      expect(result.rejections[0]?.reason).toBe("already_recorded");
      expect(result.conflictingAnswerRevision).toBe(false);
    });

    it("collapses a duplicate proposed twice in the same run", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer(), answer()] }),
        context(),
      );

      expect(result.answers).toHaveLength(1);
      expect(result.rejections[0]?.reason).toBe("duplicate_in_run");
    });

    it("treats the same subject on two questions as two distinct answers", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [answer(), answer({ questionKey: "meet_again" })],
        }),
        context(),
      );

      expect(result.answers).toHaveLength(2);
      expect(result.rejections).toEqual([]);
    });

    it("matches an existing note by content, ignoring case and whitespace", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ notes: [note({ text: "Ωραία   Βραδιά." })] }),
        context({
          acceptedNotes: [
            {
              noteType: "general",
              text: "ωραία βραδιά.",
              subjectParticipantId: null,
            },
          ],
        }),
      );

      expect(result.notes).toEqual([]);
      expect(result.rejections[0]?.reason).toBe("already_recorded");
    });
  });

  describe("goals", () => {
    it("accepts an explicit skip of an unanswered goal", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ skippedGoals: ["avoid"] }),
        context(),
      );

      expect(result.skippedGoals).toEqual(["avoid"]);
    });

    it("refuses to skip a goal answered in this run", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ answers: [answer()], skippedGoals: ["liked"] }),
        context(),
      );

      expect(result.skippedGoals).toEqual([]);
      expect(result.rejections).toContainEqual({
        scope: "goal",
        reason: "already_recorded",
        questionKey: "liked",
      });
    });

    it("refuses to skip a goal answered in an earlier run (D16)", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ skippedGoals: ["liked"] }),
        context({
          acceptedAnswers: [
            {
              questionKey: "liked",
              subjectParticipantId: eleni,
              valueInt: null,
            },
          ],
        }),
      );

      expect(result.skippedGoals).toEqual([]);
    });

    it("drops a next goal that is already terminal", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ nextGoal: "event_score", reply: "Και κάτι ακόμη;" }),
        context({
          goals: [
            {
              key: "event_score",
              ordinal: 1,
              prompt: "score;",
              status: "answered",
            },
            { key: "liked", ordinal: 2, prompt: "liked;", status: "pending" },
            {
              key: "meet_again",
              ordinal: 3,
              prompt: "meet;",
              status: "pending",
            },
            { key: "avoid", ordinal: 4, prompt: "avoid;", status: "pending" },
          ],
        }),
      );

      expect(result.nextGoal).toBeNull();
    });
  });

  describe("reply permission and safety", () => {
    it("suppresses a reply when lifecycle, control or opt-in forbid it", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ reply: "Ευχαριστούμε!" }),
        context({ replyAllowed: false }),
      );

      expect(result.reply).toBeNull();
      expect(result.replySuppressedReason).toBe("not_permitted");
    });

    it("treats a blank reply as no reply", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ reply: "   " }),
        context(),
      );

      expect(result.reply).toBeNull();
      expect(result.replySuppressedReason).toBe("empty");
    });

    it("records answers and notes alongside a safety signal (D13 amended)", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({
          answers: [answer({ questionKey: "avoid" })],
          notes: [note()],
        }),
        context(),
        [
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: ["m2"],
            confidence: 0.9,
          },
        ],
      );

      // Both survive. Suppressing the note used to make the disclosure the one
      // thing an operator could not read; the flag is the signal, not a filter.
      expect(result.answers).toHaveLength(1);
      expect(result.notes).toHaveLength(1);
      expect(result.safetySignals).toHaveLength(1);
      expect(result.rejections).toEqual([]);
    });

    it("rejects a safety classification sourced from an older turn", () => {
      const result = validateFeedbackExtractionProposal(
        proposal(),
        context({ newParticipantMessageIds: [] }),
        [
          {
            category: "sexual_misconduct",
            recommendedAction: "human_follow_up",
            sourceMessageIds: ["m2"],
            confidence: 0.8,
          },
        ],
      );

      expect(result.safetySignals).toEqual([]);
      expect(result.rejections).toEqual([
        { scope: "safety_signal", reason: "stale_source_message" },
      ]);
    });

    it("records notes on an explicit handoff too", () => {
      const result = validateFeedbackExtractionProposal(
        proposal({ notes: [note()], handoff: true }),
        context(),
      );

      expect(result.notes).toHaveLength(1);
      expect(result.handoff).toBe(true);
      expect(result.rejections).toEqual([]);
    });
  });

  it("returns nothing to persist for an empty proposal", () => {
    const result = validateFeedbackExtractionProposal(proposal(), context());

    expect(result).toMatchObject({
      answers: [],
      notes: [],
      skippedGoals: [],
      nextGoal: null,
      reply: null,
      rejections: [],
    });
  });
});

describe("feedbackExtractionProposalSchema", () => {
  it("rejects an unknown question key at the model boundary", () => {
    expect(() =>
      feedbackExtractionProposalSchema.parse({
        answers: [answer({ questionKey: "salary" as never })],
        notes: [],
        skippedGoals: [],
        nextGoal: null,
        reply: null,
        handoff: false,
        confidence: 1,
      }),
    ).toThrow();
  });

  it("rejects an unknown note type at the model boundary", () => {
    expect(() =>
      feedbackExtractionProposalSchema.parse({
        answers: [],
        notes: [note({ noteType: "safety" as never })],
        skippedGoals: [],
        nextGoal: null,
        reply: null,
        handoff: false,
        confidence: 1,
      }),
    ).toThrow();
  });

  it("rejects a note longer than the column allows", () => {
    expect(() =>
      feedbackExtractionProposalSchema.parse({
        answers: [],
        notes: [note({ text: "α".repeat(501) })],
        skippedGoals: [],
        nextGoal: null,
        reply: null,
        handoff: false,
        confidence: 1,
      }),
    ).toThrow();
  });

  it("rejects an extraction with no source message", () => {
    expect(() =>
      feedbackExtractionProposalSchema.parse({
        answers: [answer({ sourceMessageIds: [] })],
        notes: [],
        skippedGoals: [],
        nextGoal: null,
        reply: null,
        handoff: false,
        confidence: 1,
      }),
    ).toThrow();
  });

  it("rejects unknown fields so a drifting model output is caught", () => {
    expect(() =>
      feedbackExtractionProposalSchema.parse({
        answers: [],
        notes: [],
        skippedGoals: [],
        nextGoal: null,
        reply: null,
        handoff: false,
        confidence: 1,
        sendNow: true,
      }),
    ).toThrow();
  });
});
