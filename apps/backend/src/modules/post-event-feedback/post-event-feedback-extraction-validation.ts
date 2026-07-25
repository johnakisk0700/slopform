import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  isPostEventFeedbackAnswerQuestionKey,
  isPostEventFeedbackNoteType,
  type PostEventFeedbackAnswerQuestionDefinition,
  type PostEventFeedbackAnswerQuestionKey,
} from "./post-event-feedback-question-set.js";
import type {
  FeedbackExtractionAnswerProposal,
  FeedbackExtractionContext,
  FeedbackExtractionMessageView,
  FeedbackExtractionNoteProposal,
  FeedbackExtractionProposal,
  FeedbackExtractionRejection,
  ValidatedFeedbackAnswer,
  ValidatedFeedbackExtraction,
  ValidatedFeedbackNote,
} from "./post-event-feedback-extraction.schemas.js";

/**
 * The whole domain rule set for an extraction run, as one pure function.
 *
 * Nothing here reads a store, calls a provider or writes anything. That is the
 * point: the model's proposal is data until these rules accept it, and the same
 * rules can be replayed offline against the WP0 fixtures. The caller persists
 * only what comes back from here.
 *
 * The rules, in the order the plan states them (§7):
 *
 * 1. source messages must exist in *this* conversation;
 * 2. only `actor: participant` messages may support an extraction;
 * 3. question keys and note types must be allowed by the versioned set;
 * 4. a subject must be in the **current** candidate set and must not be the
 *    respondent — an unresolvable mention degrades (D18), never guesses;
 * 5. nothing already recorded is written twice;
 * 6. lifecycle, control and opt-in decide whether a reply may be produced.
 *
 * Note what is *not* a rule any more. D13 as amended routes safety-flavoured
 * content through this same path: a disclosure becomes an ordinary, visible
 * note like any other statement. Suppressing those notes made the worst
 * material the least visible — the operator saw a flag and an empty results
 * pane, and the participant's own words survived nowhere. `safetySignal` now
 * raises attention (the extractor's job) without editing what is recorded.
 */
export function validateFeedbackExtractionProposal(
  proposal: FeedbackExtractionProposal,
  context: FeedbackExtractionContext,
): ValidatedFeedbackExtraction {
  const rejections: FeedbackExtractionRejection[] = [];
  const messagesById = new Map(
    context.messages.map((message) => [message.id, message]),
  );
  const candidateIds = new Set(
    context.candidates.map((candidate) => candidate.participantId),
  );

  const answers = validateAnswers(
    proposal.answers,
    context,
    messagesById,
    candidateIds,
    rejections,
  );
  const notes = validateNotes(
    proposal.notes,
    context,
    messagesById,
    candidateIds,
    rejections,
  );

  const answeredKeys = new Set<PostEventFeedbackAnswerQuestionKey>([
    ...context.acceptedAnswers.map((answer) => answer.questionKey),
    ...answers.map((answer) => answer.questionKey),
  ]);
  const skippedGoals = validateSkippedGoals(
    proposal.skippedGoals,
    context,
    answeredKeys,
    rejections,
  );

  const nextGoal = resolveNextGoal(proposal.nextGoal, context);
  const trimmedReply = proposal.reply?.trim() ?? "";
  const reply =
    context.replyAllowed && trimmedReply.length > 0 ? trimmedReply : null;

  return {
    answers,
    notes,
    skippedGoals,
    nextGoal,
    reply,
    replySuppressedReason: resolveReplySuppression(
      context.replyAllowed,
      trimmedReply,
    ),
    safetySignal: proposal.safetySignal,
    handoff: proposal.handoff,
    confidence: proposal.confidence,
    rejections,
  };
}

function validateAnswers(
  proposals: readonly FeedbackExtractionAnswerProposal[],
  context: FeedbackExtractionContext,
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
  candidateIds: ReadonlySet<string>,
  rejections: FeedbackExtractionRejection[],
): ValidatedFeedbackAnswer[] {
  const accepted: ValidatedFeedbackAnswer[] = [];
  const seen = new Set(
    context.acceptedAnswers.map((answer) =>
      answerIdentity(answer.questionKey, answer.subjectParticipantId),
    ),
  );

  for (const proposal of proposals) {
    const reject = (
      reason: FeedbackExtractionRejection["reason"],
    ): undefined => {
      rejections.push({
        scope: "answer",
        reason,
        questionKey: proposal.questionKey,
      });
      return undefined;
    };

    if (!isPostEventFeedbackAnswerQuestionKey(proposal.questionKey)) {
      reject("disallowed_question_key");
      continue;
    }
    const provenance = checkProvenance(proposal.sourceMessageIds, messagesById);
    if (provenance) {
      reject(provenance);
      continue;
    }

    const definition = answerDefinition(proposal.questionKey);
    let subjectParticipantId: string | null = null;
    let valueInt: number | null = null;

    if (definition.subjectless) {
      if (proposal.subjectParticipantId || proposal.subjectMentionedName) {
        reject("subject_on_subjectless_question");
        continue;
      }
      if (!isValidScore(proposal.valueInt, definition)) {
        reject("invalid_score");
        continue;
      }
      valueInt = proposal.valueInt;
    } else {
      // A directed answer without a resolved subject asserts nothing, and a
      // guessed id would assert the wrong thing about a real person. The answer
      // is dropped; the participant's own words survive through notes, which is
      // where D18's degradation lives.
      if (!proposal.subjectParticipantId) {
        reject(
          proposal.subjectMentionedName
            ? "unresolved_subject"
            : "missing_subject",
        );
        continue;
      }
      if (proposal.subjectParticipantId === context.respondentParticipantId) {
        reject("subject_is_respondent");
        continue;
      }
      if (!candidateIds.has(proposal.subjectParticipantId)) {
        reject("unresolved_subject");
        continue;
      }
      subjectParticipantId = proposal.subjectParticipantId;
    }

    const identity = answerIdentity(proposal.questionKey, subjectParticipantId);
    if (seen.has(identity)) {
      // The unique constraint would absorb this anyway; rejecting it here keeps
      // the run's own reporting honest about what it actually wrote.
      reject(
        context.acceptedAnswers.some(
          (answer) =>
            answerIdentity(answer.questionKey, answer.subjectParticipantId) ===
            identity,
        )
          ? "already_recorded"
          : "duplicate_in_run",
      );
      continue;
    }
    seen.add(identity);

    accepted.push({
      questionKey: proposal.questionKey,
      valueInt,
      subjectParticipantId,
      sourceMessageIds: [...new Set(proposal.sourceMessageIds)],
      confidence: proposal.confidence,
    });
  }

  return accepted;
}

function validateNotes(
  proposals: readonly FeedbackExtractionNoteProposal[],
  context: FeedbackExtractionContext,
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
  candidateIds: ReadonlySet<string>,
  rejections: FeedbackExtractionRejection[],
): ValidatedFeedbackNote[] {
  const accepted: ValidatedFeedbackNote[] = [];
  const seen = new Set(
    context.acceptedNotes.map((note) =>
      noteIdentity(note.noteType, note.text, note.subjectParticipantId),
    ),
  );

  for (const proposal of proposals) {
    const reject = (
      reason: FeedbackExtractionRejection["reason"],
    ): undefined => {
      rejections.push({ scope: "note", reason, noteType: proposal.noteType });
      return undefined;
    };

    if (!isPostEventFeedbackNoteType(proposal.noteType)) {
      reject("disallowed_note_type");
      continue;
    }
    const provenance = checkProvenance(proposal.sourceMessageIds, messagesById);
    if (provenance) {
      reject(provenance);
      continue;
    }

    // D18: an unresolvable or self-referential subject degrades to a subjectless
    // note that keeps the name in its text and is flagged for review. It never
    // becomes a guessed participant id.
    const resolvable =
      proposal.subjectParticipantId &&
      proposal.subjectParticipantId !== context.respondentParticipantId &&
      candidateIds.has(proposal.subjectParticipantId);
    const degraded =
      Boolean(proposal.subjectParticipantId || proposal.subjectMentionedName) &&
      !resolvable;
    const subjectParticipantId = resolvable
      ? proposal.subjectParticipantId
      : null;

    const text = proposal.text.trim();
    const identity = noteIdentity(
      proposal.noteType,
      text,
      subjectParticipantId,
    );
    if (seen.has(identity)) {
      // `feedback_notes` has no natural unique key, so this content signature is
      // the note's replay guard together with the extraction cursor.
      reject(
        context.acceptedNotes.some(
          (note) =>
            noteIdentity(
              note.noteType,
              note.text,
              note.subjectParticipantId,
            ) === identity,
        )
          ? "already_recorded"
          : "duplicate_in_run",
      );
      continue;
    }
    seen.add(identity);

    accepted.push({
      noteType: proposal.noteType,
      text,
      subjectParticipantId,
      sourceMessageIds: [...new Set(proposal.sourceMessageIds)],
      confidence: proposal.confidence,
      flaggedForReview: degraded,
      unresolvedSubjectName: degraded
        ? (proposal.subjectMentionedName ?? null)
        : null,
    });
  }

  return accepted;
}

/**
 * D3 locks every question as skippable. D16 forbids reopening an answered goal,
 * and the same reasoning forbids retroactively skipping one.
 */
function validateSkippedGoals(
  proposals: readonly PostEventFeedbackAnswerQuestionKey[],
  context: FeedbackExtractionContext,
  answeredKeys: ReadonlySet<PostEventFeedbackAnswerQuestionKey>,
  rejections: FeedbackExtractionRejection[],
): PostEventFeedbackAnswerQuestionKey[] {
  const goalKeys = new Set(context.goals.map((goal) => goal.key));
  const skipped: PostEventFeedbackAnswerQuestionKey[] = [];

  for (const key of proposals) {
    if (!goalKeys.has(key) || answeredKeys.has(key)) {
      rejections.push({
        scope: "goal",
        reason: goalKeys.has(key) ? "already_recorded" : "unknown_goal",
        questionKey: key,
      });
      continue;
    }
    if (!skipped.includes(key)) {
      skipped.push(key);
    }
  }

  return skipped;
}

function resolveNextGoal(
  nextGoal: PostEventFeedbackAnswerQuestionKey | null,
  context: FeedbackExtractionContext,
): PostEventFeedbackAnswerQuestionKey | null {
  if (!nextGoal) {
    return null;
  }
  const goal = context.goals.find((entry) => entry.key === nextGoal);
  return goal && goal.status !== "answered" && goal.status !== "skipped"
    ? nextGoal
    : null;
}

function resolveReplySuppression(
  replyAllowed: boolean,
  trimmedReply: string,
): ValidatedFeedbackExtraction["replySuppressedReason"] {
  if (!replyAllowed) {
    return "not_permitted";
  }
  return trimmedReply.length === 0 ? "empty" : null;
}

/**
 * Provenance is the first gate for both answers and notes: a referenced message
 * must exist in this conversation, and only the participant's own words may
 * become their feedback. Bot prompts and staff follow-ups are context, never
 * testimony.
 */
function checkProvenance(
  sourceMessageIds: readonly string[],
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
): "unknown_source_message" | "non_participant_source" | undefined {
  for (const id of sourceMessageIds) {
    const message = messagesById.get(id);
    if (!message) {
      return "unknown_source_message";
    }
    if (message.actor !== "participant") {
      return "non_participant_source";
    }
  }
  return undefined;
}

function answerDefinition(
  key: PostEventFeedbackAnswerQuestionKey,
): PostEventFeedbackAnswerQuestionDefinition {
  const definition = POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.find(
    (question) => question.key === key,
  );
  if (!definition) {
    throw new Error(`Unknown feedback question key: ${key}`);
  }
  return definition;
}

function isValidScore(
  value: number | null,
  definition: PostEventFeedbackAnswerQuestionDefinition,
): value is number {
  return (
    value !== null &&
    Number.isInteger(value) &&
    value >= (definition.intMin ?? Number.NEGATIVE_INFINITY) &&
    value <= (definition.intMax ?? Number.POSITIVE_INFINITY)
  );
}

/** Mirrors `UNIQUE NULLS NOT DISTINCT (conversation, question_key, subject)`. */
function answerIdentity(
  questionKey: string,
  subjectParticipantId: string | null,
): string {
  return `${questionKey}::${subjectParticipantId ?? ""}`;
}

function noteIdentity(
  noteType: string,
  text: string,
  subjectParticipantId: string | null,
): string {
  return `${noteType}::${subjectParticipantId ?? ""}::${text
    .trim()
    .replaceAll(/\s+/gu, " ")
    .toLowerCase()}`;
}
