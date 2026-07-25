import type {
  PostEventFeedbackAnswerQuestionKey,
  PostEventFeedbackNoteType,
} from "./post-event-feedback-question-set.js";

export type PostEventFeedbackFixtureActor =
  "bot" | "participant" | "staff" | "system";

export type PostEventFeedbackFixtureMessage = {
  id: string;
  actor: PostEventFeedbackFixtureActor;
  text: string;
};

export type PostEventFeedbackFixtureCandidate = {
  participantId: string;
  displayName: string;
};

export type PostEventFeedbackFixtureExpectedAnswer = {
  questionKey: PostEventFeedbackAnswerQuestionKey;
  valueInt?: number;
  subjectParticipantIds?: readonly string[];
  skipped?: boolean;
};

export type PostEventFeedbackFixtureExpectedNote = {
  noteType: PostEventFeedbackNoteType;
  text: string;
  subjectParticipantId?: string | null;
  flaggedForReview?: boolean;
};

export type PostEventFeedbackFixtureExpectedOutcome = {
  stopMatched?: boolean;
  needsAttention?: boolean;
  safetySignal?: boolean;
  handoff?: boolean;
  clarificationNeeded?: boolean;
  answers: readonly PostEventFeedbackFixtureExpectedAnswer[];
  notes: readonly PostEventFeedbackFixtureExpectedNote[];
};

export type PostEventFeedbackExtractionFixture = {
  id: string;
  description: string;
  respondentParticipantId: string;
  candidates: readonly PostEventFeedbackFixtureCandidate[];
  messages: readonly PostEventFeedbackFixtureMessage[];
  expected: PostEventFeedbackFixtureExpectedOutcome;
};

const FIXTURE_CANDIDATES = {
  maria: { participantId: "p-maria", displayName: "Μαρία" },
  nikos: { participantId: "p-nikos", displayName: "Νίκος" },
  kostasA: { participantId: "p-kostas-a", displayName: "Κώστας Π." },
  kostasB: { participantId: "p-kostas-b", displayName: "Κώστας Γ." },
  eleni: { participantId: "p-eleni", displayName: "Ελένη" },
  roula: { participantId: "p-roula", displayName: "Ρούλα" },
} as const;

export const POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES = [
  {
    id: "happy_path",
    description:
      "Participant answers score, names one liked candidate and one meet-again candidate.",
    respondentParticipantId: FIXTURE_CANDIDATES.maria.participantId,
    candidates: [
      FIXTURE_CANDIDATES.nikos,
      FIXTURE_CANDIDATES.eleni,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Γεια σου Μαρία! Εδώ η ομάδα του Join The Six 🙂",
      },
      {
        id: "m2",
        actor: "participant",
        text: "4 — πολύ καλή βραδιά!",
      },
      {
        id: "m3",
        actor: "bot",
        text: "Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
      },
      {
        id: "m4",
        actor: "participant",
        text: "Ο Νίκος ήταν πολύ ενδιαφέρων.",
      },
      {
        id: "m5",
        actor: "bot",
        text: "Με ποιους από την παρέα θα ήθελες να ξαναβρεθείς σε επόμενο τραπέζι;",
      },
      {
        id: "m6",
        actor: "participant",
        text: "Θα ήθελα να ξαναδώ την Ελένη. Θα ήθελα και πεζοπορία μαζί της κάποια στιγμή.",
      },
    ],
    expected: {
      answers: [
        { questionKey: "event_score", valueInt: 4 },
        {
          questionKey: "liked",
          subjectParticipantIds: [FIXTURE_CANDIDATES.nikos.participantId],
        },
        {
          questionKey: "meet_again",
          subjectParticipantIds: [FIXTURE_CANDIDATES.eleni.participantId],
        },
      ],
      notes: [
        {
          noteType: "activity_interest",
          text: "Θα ήθελα πεζοπορία μαζί της κάποια στιγμή.",
          subjectParticipantId: FIXTURE_CANDIDATES.eleni.participantId,
        },
      ],
    },
  },
  {
    id: "multi_message_burst",
    description:
      "Participant sends score, liked and meet-again answers in one burst.",
    respondentParticipantId: FIXTURE_CANDIDATES.nikos.participantId,
    candidates: [
      FIXTURE_CANDIDATES.maria,
      FIXTURE_CANDIDATES.eleni,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
      },
      {
        id: "m2",
        actor: "participant",
        text: "5! Η Μαρία ήταν φοβερή και θα ήθελα να ξαναβρεθώ μαζί της. Η βραδιά κύλησε γρήγορα.",
      },
    ],
    expected: {
      answers: [
        { questionKey: "event_score", valueInt: 5 },
        {
          questionKey: "liked",
          subjectParticipantIds: [FIXTURE_CANDIDATES.maria.participantId],
        },
        {
          questionKey: "meet_again",
          subjectParticipantIds: [FIXTURE_CANDIDATES.maria.participantId],
        },
      ],
      notes: [
        {
          noteType: "general",
          text: "Η βραδιά κύλησε γρήγορα.",
          subjectParticipantId: null,
        },
      ],
    },
  },
  {
    id: "two_kostas_ambiguity",
    description:
      "Two candidates share the first name Κώστας; extraction must not guess a subject.",
    respondentParticipantId: FIXTURE_CANDIDATES.eleni.participantId,
    candidates: [
      FIXTURE_CANDIDATES.maria,
      FIXTURE_CANDIDATES.kostasA,
      FIXTURE_CANDIDATES.kostasB,
      FIXTURE_CANDIDATES.nikos,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
      },
      {
        id: "m2",
        actor: "participant",
        text: "Ο Κώστας ήταν τέλειος, πολύ διασκεδαστικός.",
      },
    ],
    expected: {
      clarificationNeeded: true,
      answers: [
        {
          questionKey: "liked",
          skipped: true,
        },
      ],
      notes: [],
    },
  },
  {
    id: "unknown_name_subjectless_note",
    description:
      "Participant praises Ρούλα who is not in the current candidate set.",
    respondentParticipantId: FIXTURE_CANDIDATES.maria.participantId,
    candidates: [
      FIXTURE_CANDIDATES.nikos,
      FIXTURE_CANDIDATES.eleni,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
      },
      {
        id: "m2",
        actor: "participant",
        text: "Η Ρούλα ήταν πολύ γλυκιά και ενδιαφέρουσα.",
      },
    ],
    expected: {
      notes: [
        {
          noteType: "general",
          text: "Η Ρούλα ήταν πολύ γλυκιά και ενδιαφέρουσα.",
          subjectParticipantId: null,
          flaggedForReview: true,
        },
      ],
      answers: [],
    },
  },
  {
    id: "unrelated_chat",
    description:
      "Participant sends off-topic chat without structured feedback signals.",
    respondentParticipantId: FIXTURE_CANDIDATES.nikos.participantId,
    candidates: [
      FIXTURE_CANDIDATES.maria,
      FIXTURE_CANDIDATES.eleni,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
      },
      {
        id: "m2",
        actor: "participant",
        text: "Έχετε δει καιρό τι καιρό θα κάνει αύριο;",
      },
    ],
    expected: {
      answers: [],
      notes: [],
    },
  },
  {
    id: "safety_language",
    description:
      "Participant uses language that should trigger safety handoff, not ordinary notes.",
    respondentParticipantId: FIXTURE_CANDIDATES.maria.participantId,
    candidates: [
      FIXTURE_CANDIDATES.nikos,
      FIXTURE_CANDIDATES.eleni,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
      },
      {
        id: "m2",
        actor: "participant",
        text: "Δεν θέλω να ζήσω άλλο. Νιώθω ότι δεν αντέχω.",
      },
    ],
    expected: {
      safetySignal: true,
      needsAttention: true,
      handoff: true,
      answers: [],
      notes: [],
    },
  },
  {
    id: "stop_mid_flow",
    description:
      "Participant sends STOP while the bot is mid-questionnaire; no extraction.",
    respondentParticipantId: FIXTURE_CANDIDATES.eleni.participantId,
    candidates: [
      FIXTURE_CANDIDATES.maria,
      FIXTURE_CANDIDATES.nikos,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
      },
      {
        id: "m2",
        actor: "participant",
        text: "3",
      },
      {
        id: "m3",
        actor: "bot",
        text: "Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
      },
      {
        id: "m4",
        actor: "participant",
        text: "ΣΤΟΠ",
      },
    ],
    expected: {
      stopMatched: true,
      answers: [{ questionKey: "event_score", valueInt: 3 }],
      notes: [],
    },
  },
  {
    id: "staff_follow_up_after_takeover",
    description:
      "After staff takeover, participant answers a staff follow-up; only participant text may become testimony.",
    respondentParticipantId: FIXTURE_CANDIDATES.nikos.participantId,
    candidates: [
      FIXTURE_CANDIDATES.maria,
      FIXTURE_CANDIDATES.eleni,
      FIXTURE_CANDIDATES.kostasA,
    ],
    messages: [
      {
        id: "m1",
        actor: "bot",
        text: "Με ποιους από την παρέα θα ήθελες να ξαναβρεθείς σε επόμενο τραπέζι;",
      },
      {
        id: "m2",
        actor: "staff",
        text: "Γεια σου Νίκο, είμαι η Μαρία από την ομάδα — μπορείς να μου πεις αν θες να ξαναδείς κάποιον συγκεκριμένα;",
      },
      {
        id: "m3",
        actor: "participant",
        text: "Ναι, θα ήθελα να ξαναβρεθώ με την Ελένη.",
      },
    ],
    expected: {
      answers: [
        {
          questionKey: "meet_again",
          subjectParticipantIds: [FIXTURE_CANDIDATES.eleni.participantId],
        },
      ],
      notes: [],
    },
  },
] satisfies readonly PostEventFeedbackExtractionFixture[];

export type PostEventFeedbackExtractionFixtureId =
  (typeof POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES)[number]["id"];

export function getPostEventFeedbackExtractionFixture(
  id: PostEventFeedbackExtractionFixtureId,
): PostEventFeedbackExtractionFixture {
  const fixture = POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES.find(
    (entry) => entry.id === id,
  );
  if (!fixture) {
    throw new Error(`Unknown post-event feedback fixture: ${id}`);
  }
  return fixture;
}
