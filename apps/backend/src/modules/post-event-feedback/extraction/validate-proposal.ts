import type { FeedbackAnswerQuestionKey } from "@slopform/database";
import { resolvePostEventFeedbackCandidateByName } from "../matching/candidate-name.js";
import {
  foldPostEventFeedbackText,
  foldedTextContainsAtWordStart,
} from "../matching/fold-text.js";
import {
  getPostEventFeedbackAnswerQuestionDefinition,
  isAgreeingDirectedPostEventFeedbackQuestion,
  isDirectedPostEventFeedbackQuestion,
  isPostEventFeedbackAnswerQuestionKey,
  isPostEventFeedbackNoteType,
  noteSignature,
  type PostEventFeedbackAnswerQuestionDefinition,
} from "../question-set.js";
import type {
  FeedbackExtractionAnswerProposal,
  FeedbackExtractionContext,
  FeedbackExtractionMessageView,
  FeedbackExtractionNoteProposal,
  FeedbackExtractionProposal,
  FeedbackExtractionRejection,
  FeedbackExtractionSafetySignalProposal,
  ValidatedFeedbackAnswer,
  ValidatedFeedbackExtraction,
  ValidatedFeedbackNote,
  ValidatedFeedbackSafetySignal,
} from "./extraction.schemas.js";

/**
 * Pure domain rules for one extraction proposal. No store, provider or write.
 * Provenance, participant-only sources, live D16 subjects, D18 degradation,
 * uniqueness, reply permission, and `handoff_discards_testimony`. Safety notes
 * travel this same path (D13).
 */
export type FeedbackExtractionValidationResult = ValidatedFeedbackExtraction & {
  /**
   * Stored answer proposed with a different value. Ordinary revisions write;
   * operator-corrected rows refuse and raise `answer_revision`.
   */
  readonly conflictingAnswerRevision: boolean;
};

export function validateFeedbackExtractionProposal(
  proposal: FeedbackExtractionProposal,
  context: FeedbackExtractionContext,
  attentionSignals: readonly FeedbackExtractionSafetySignalProposal[] = [],
): FeedbackExtractionValidationResult {
  const rejections: FeedbackExtractionRejection[] = [];
  const messagesById = new Map(
    context.messages.map((message) => [message.id, message]),
  );
  const candidateIds = new Set(
    context.candidates.map((candidate) => candidate.participantId),
  );
  const newParticipantMessageIds = new Set(context.newParticipantMessageIds);

  const verdicts = splitGoalVerdicts(proposal.goals, context, rejections);
  const answersResult = validateAnswers(
    verdicts.answers,
    context,
    messagesById,
    newParticipantMessageIds,
    candidateIds,
    rejections,
  );
  const notes = validateNotes(
    proposal.notes,
    context,
    messagesById,
    newParticipantMessageIds,
    candidateIds,
    rejections,
  );
  const safetySignals = validateSafetySignals(
    attentionSignals,
    messagesById,
    newParticipantMessageIds,
    rejections,
  );

  const answeredKeys = new Set<FeedbackAnswerQuestionKey>([
    ...context.acceptedAnswers.map((answer) => answer.questionKey),
    ...answersResult.answers.map((answer) => answer.questionKey),
  ]);
  const skippedGoals = validateSkippedGoals(
    verdicts.declined,
    context,
    answeredKeys,
    // Model answered verdicts, not accepted ones. Replay `already_recorded`
    // must not skip a goal the first run kept open.
    verdicts.answers,
    rejections,
  );

  const nextGoal = resolveNextGoal(proposal.nextGoal, context);
  const trimmedReply = proposal.reply?.trim() ?? "";
  const reply =
    context.replyAllowed && trimmedReply.length > 0 ? trimmedReply : null;

  const abandonedHandoff = discardsTestimony({
    handoff: proposal.handoff,
    answers: answersResult.answers,
    notes,
    safetySignals,
    rejections,
    context,
  });
  if (abandonedHandoff) {
    rejections.push({ scope: "handoff", reason: "handoff_discards_testimony" });
  }

  return {
    answers: answersResult.answers,
    notes,
    skippedGoals,
    nextGoal,
    reply,
    replySuppressedReason: resolveReplySuppression(
      context.replyAllowed,
      trimmedReply,
    ),
    safetySignals,
    // Rejected handoff is reported false so the result does not contradict itself.
    handoff: proposal.handoff && !abandonedHandoff,
    confidence: proposal.confidence,
    rejections,
    conflictingAnswerRevision: answersResult.conflictingAnswerRevision,
  };
}

/**
 * Flatten per-goal verdicts into answers + declined keys. `not_addressed` and
 * `already_settled` record nothing.
 */
function splitGoalVerdicts(
  goals: FeedbackExtractionProposal["goals"],
  context: FeedbackExtractionContext,
  rejections: FeedbackExtractionRejection[],
): {
  readonly answers: FeedbackExtractionAnswerProposal[];
  readonly declined: FeedbackAnswerQuestionKey[];
} {
  const answers: FeedbackExtractionAnswerProposal[] = [];
  const declined: FeedbackAnswerQuestionKey[] = [];
  const expectedGoalKeys = new Set(context.goals.map((goal) => goal.key));

  for (const goal of context.goals) {
    if (!Object.hasOwn(goals, goal.key)) {
      rejections.push({
        scope: "goal",
        reason: "missing_goal_verdict",
        questionKey: goal.key,
      });
    }
  }

  for (const [key, verdict] of Object.entries(goals) as [
    FeedbackAnswerQuestionKey,
    FeedbackExtractionProposal["goals"][FeedbackAnswerQuestionKey],
  ][]) {
    if (!expectedGoalKeys.has(key)) {
      rejections.push({
        scope: "goal",
        reason: "unknown_goal",
        questionKey: key,
      });
      continue;
    }
    if (!verdict) {
      continue;
    }
    if (verdict.status === "answered") {
      // `answered` with no answers is a visible fault, not a quiet open goal.
      if (verdict.answers.length === 0) {
        rejections.push({
          scope: "goal",
          reason: "empty_answered_verdict",
          questionKey: key,
        });
        continue;
      }
      for (const answer of verdict.answers) {
        answers.push({ questionKey: key, ...answer });
      }
      continue;
    }
    if (verdict.status === "declined") {
      declined.push(key);
    }
  }

  return { answers, declined };
}

function validateSafetySignals(
  proposals: readonly FeedbackExtractionSafetySignalProposal[],
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
  newParticipantMessageIds: ReadonlySet<string>,
  rejections: FeedbackExtractionRejection[],
): ValidatedFeedbackSafetySignal[] {
  const accepted: ValidatedFeedbackSafetySignal[] = [];
  const seen = new Set<string>();

  for (const proposal of proposals) {
    const provenance = checkProvenance(
      proposal.sourceMessageIds,
      messagesById,
      newParticipantMessageIds,
    );
    if (provenance) {
      rejections.push({ scope: "safety_signal", reason: provenance });
      continue;
    }

    const sourceMessageIds = [...new Set(proposal.sourceMessageIds)];
    const identity = `${proposal.category}:${proposal.recommendedAction}:${sourceMessageIds
      .slice()
      .sort()
      .join(",")}`;
    if (seen.has(identity)) {
      rejections.push({
        scope: "safety_signal",
        reason: "duplicate_in_run",
      });
      continue;
    }
    seen.add(identity);

    accepted.push({
      category: proposal.category,
      recommendedAction: proposal.recommendedAction,
      sourceMessageIds,
      confidence: proposal.confidence,
    });
  }

  return accepted;
}

function validateAnswers(
  proposals: readonly FeedbackExtractionAnswerProposal[],
  context: FeedbackExtractionContext,
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
  newParticipantMessageIds: ReadonlySet<string>,
  candidateIds: ReadonlySet<string>,
  rejections: FeedbackExtractionRejection[],
): {
  answers: ValidatedFeedbackAnswer[];
  conflictingAnswerRevision: boolean;
} {
  const accepted: ValidatedFeedbackAnswer[] = [];
  let conflictingAnswerRevision = false;
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

    if (
      !isPostEventFeedbackAnswerQuestionKey(proposal.questionKey) ||
      !context.goals.some((goal) => goal.key === proposal.questionKey)
    ) {
      reject("disallowed_question_key");
      continue;
    }
    const provenance = checkProvenance(
      proposal.sourceMessageIds,
      messagesById,
      newParticipantMessageIds,
    );
    if (provenance) {
      reject(provenance);
      continue;
    }

    const definition = getPostEventFeedbackAnswerQuestionDefinition(
      proposal.questionKey,
    );
    if (!definition) {
      reject("disallowed_question_key");
      continue;
    }
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
      // Unresolved directed subject: drop the answer (D18 notes keep the words).
      // Transliteration resolves only when exactly one candidate fits.
      const resolvedId =
        proposal.subjectParticipantId ??
        resolvePostEventFeedbackCandidateByName(
          proposal.subjectMentionedName,
          context.candidates,
        )?.participantId ??
        null;

      if (!resolvedId) {
        reject(
          proposal.subjectMentionedName
            ? "unresolved_subject"
            : "missing_subject",
        );
        continue;
      }
      if (resolvedId === context.respondentParticipantId) {
        reject("subject_is_respondent");
        continue;
      }
      if (!candidateIds.has(resolvedId)) {
        reject("unresolved_subject");
        continue;
      }
      subjectParticipantId = resolvedId;
    }

    const identity = answerIdentity(proposal.questionKey, subjectParticipantId);
    if (seen.has(identity)) {
      const stored = context.acceptedAnswers.find(
        (answer) =>
          answerIdentity(answer.questionKey, answer.subjectParticipantId) ===
          identity,
      );
      const earlierInRun = accepted.findIndex(
        (answer) =>
          answerIdentity(answer.questionKey, answer.subjectParticipantId) ===
          identity,
      );
      const previousValue =
        stored?.valueInt ?? accepted[earlierInRun]?.valueInt ?? null;

      // Same value: replay or duplicate.
      if (previousValue === valueInt) {
        reject(stored ? "already_recorded" : "duplicate_in_run");
        continue;
      }

      // Operator-corrected rows are frozen. Newest-testimony-wins does not apply.
      if (stored?.correctedByOperator) {
        conflictingAnswerRevision = true;
        reject("answer_corrected_by_operator");
        continue;
      }

      // Different value: newest testimony wins.
      if (stored) {
        conflictingAnswerRevision = true;
      }
      if (earlierInRun !== -1) {
        accepted.splice(earlierInRun, 1);
      }
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

  return { answers: accepted, conflictingAnswerRevision };
}

function validateNotes(
  proposals: readonly FeedbackExtractionNoteProposal[],
  context: FeedbackExtractionContext,
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
  newParticipantMessageIds: ReadonlySet<string>,
  candidateIds: ReadonlySet<string>,
  rejections: FeedbackExtractionRejection[],
): ValidatedFeedbackNote[] {
  const accepted: ValidatedFeedbackNote[] = [];
  const seen = new Set(
    context.acceptedNotes.map((note) =>
      noteSignature(note.noteType, note.text, note.subjectParticipantId),
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
    const provenance = checkProvenance(
      proposal.sourceMessageIds,
      messagesById,
      newParticipantMessageIds,
    );
    if (provenance) {
      reject(provenance);
      continue;
    }

    // D18: unresolvable subject → subjectless flagged note. Same transliteration rescue.
    const proposedId =
      proposal.subjectParticipantId ??
      resolvePostEventFeedbackCandidateByName(
        proposal.subjectMentionedName,
        context.candidates,
      )?.participantId ??
      null;
    const resolvable =
      proposedId &&
      proposedId !== context.respondentParticipantId &&
      candidateIds.has(proposedId);
    // Self-reference is not an unresolved name. Subjectless, unflagged.
    const selfReferential =
      proposedId === context.respondentParticipantId ||
      matchesRespondentName(proposal.subjectMentionedName, context);
    const degraded =
      Boolean(proposal.subjectParticipantId || proposal.subjectMentionedName) &&
      !resolvable &&
      !selfReferential;
    const subjectParticipantId = resolvable ? proposedId : null;

    const text = proposal.text.trim();
    const identity = noteSignature(
      proposal.noteType,
      text,
      subjectParticipantId,
    );
    if (seen.has(identity)) {
      // Note replay guard: content signature + extraction cursor.
      reject(
        context.acceptedNotes.some(
          (note) =>
            noteSignature(
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
 * Skips. Answered goals never skip (D16). V1: refuse `liked`/`meet_again`
 * declined while still `pending` if this testimony answered another goal
 * (`declined_before_asked`). Whole-questionnaire refusal (no answers) stays
 * cheap. `avoid` is outside the rule.
 */
function validateSkippedGoals(
  proposals: readonly FeedbackAnswerQuestionKey[],
  context: FeedbackExtractionContext,
  answeredKeys: ReadonlySet<FeedbackAnswerQuestionKey>,
  proposedAnswers: readonly FeedbackExtractionAnswerProposal[],
  rejections: FeedbackExtractionRejection[],
): FeedbackAnswerQuestionKey[] {
  const goalKeys = new Set(context.goals.map((goal) => goal.key));
  const hasAgreeingPair = goalKeys.has("liked") && goalKeys.has("meet_again");
  const skipped: FeedbackAnswerQuestionKey[] = [];

  for (const key of proposals) {
    if (!goalKeys.has(key) || answeredKeys.has(key)) {
      rejections.push({
        scope: "goal",
        reason: goalKeys.has(key) ? "already_recorded" : "unknown_goal",
        questionKey: key,
      });
      continue;
    }
    if (
      proposedAnswers.length > 0 &&
      hasAgreeingPair &&
      isAgreeingDirectedPostEventFeedbackQuestion(key) &&
      context.goals.find((goal) => goal.key === key)?.status === "pending"
    ) {
      rejections.push({
        scope: "goal",
        reason: "declined_before_asked",
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

/**
 * Handoff with nothing recorded over testimony that still holds an askable
 * answer. Safety, an answer/note, or `already_recorded` keep the handoff path.
 * A plain "speak to a person" with nothing to extract must still work.
 */
function discardsTestimony(input: {
  readonly handoff: boolean;
  readonly answers: readonly ValidatedFeedbackAnswer[];
  readonly notes: readonly ValidatedFeedbackNote[];
  readonly safetySignals: readonly ValidatedFeedbackSafetySignal[];
  readonly rejections: readonly FeedbackExtractionRejection[];
  readonly context: FeedbackExtractionContext;
}): boolean {
  return (
    input.handoff &&
    input.answers.length === 0 &&
    input.notes.length === 0 &&
    input.safetySignals.length === 0 &&
    !input.rejections.some(
      (rejection) => rejection.reason === "already_recorded",
    ) &&
    holdsUnrecordedAnswer(input.context)
  );
}

/**
 * Shallow scan: open goal still has a score or unrecorded candidate name in
 * new testimony. Replay is harmless once that goal is recorded.
 */
function holdsUnrecordedAnswer(context: FeedbackExtractionContext): boolean {
  const newTestimony = context.messages
    .filter((message) => context.newParticipantMessageIds.includes(message.id))
    .map((message) => message.text)
    .join(" ");
  if (newTestimony.trim().length === 0) {
    return false;
  }

  const answeredKeys = new Set<FeedbackAnswerQuestionKey>(
    context.acceptedAnswers.map((answer) => answer.questionKey),
  );
  const isOpen = (key: FeedbackAnswerQuestionKey): boolean => {
    if (answeredKeys.has(key)) {
      return false;
    }
    const goal = context.goals.find((entry) => entry.key === key);
    return (
      goal !== undefined &&
      goal.status !== "answered" &&
      goal.status !== "skipped"
    );
  };

  const scoredOpen = context.goals.some((goal) => {
    if (!isOpen(goal.key)) {
      return false;
    }
    const definition = getPostEventFeedbackAnswerQuestionDefinition(goal.key);
    return (
      definition?.valueKind === "int" && mentionsScore(newTestimony, definition)
    );
  });
  if (scoredOpen) {
    return true;
  }
  // Name is unspent only while a directed goal is open and no answer names them.
  const directedOpen = context.goals.some(
    (goal) => isDirectedPostEventFeedbackQuestion(goal.key) && isOpen(goal.key),
  );
  return directedOpen && mentionsUnrecordedCandidate(newTestimony, context);
}

/** Folded standalone digit in the question's int range. */
function mentionsScore(
  text: string,
  definition: PostEventFeedbackAnswerQuestionDefinition,
): boolean {
  const minimum = definition.intMin ?? Number.NEGATIVE_INFINITY;
  const maximum = definition.intMax ?? Number.POSITIVE_INFINITY;
  return foldPostEventFeedbackText(text)
    .split(" ")
    .some((token) => {
      const value = Number(token);
      return /^\d+$/u.test(token) && value >= minimum && value <= maximum;
    });
}

/**
 * Current candidate named and not yet answered. Same resolver as a mention;
 * ambiguous names stay unresolved and the handoff stands.
 */
function mentionsUnrecordedCandidate(
  newTestimony: string,
  context: FeedbackExtractionContext,
): boolean {
  const named = resolvePostEventFeedbackCandidateByName(
    newTestimony,
    context.candidates,
  );
  if (!named) {
    return false;
  }
  return !context.acceptedAnswers.some(
    (answer) => answer.subjectParticipantId === named.participantId,
  );
}

function resolveNextGoal(
  nextGoal: FeedbackAnswerQuestionKey | null,
  context: FeedbackExtractionContext,
): FeedbackAnswerQuestionKey | null {
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
 * Provenance: every cited message is this conversation's participant text, and
 * at least one citation is inside the cursor window. Older citations may stay
 * so the row shows the whole thought.
 */
function checkProvenance(
  sourceMessageIds: readonly string[],
  messagesById: ReadonlyMap<string, FeedbackExtractionMessageView>,
  newParticipantMessageIds: ReadonlySet<string>,
):
  | "unknown_source_message"
  | "non_participant_source"
  | "stale_source_message"
  | undefined {
  let citesNewTestimony = false;

  for (const id of sourceMessageIds) {
    const message = messagesById.get(id);
    if (!message) {
      return "unknown_source_message";
    }
    if (message.actor !== "participant") {
      return "non_participant_source";
    }
    if (newParticipantMessageIds.has(id)) {
      citesNewTestimony = true;
    }
  }

  return citesNewTestimony ? undefined : "stale_source_message";
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

/**
 * Mention is the respondent's own name (folded STOP matcher; word-start
 * containment for Greek inflection).
 */
function matchesRespondentName(
  mentionedName: string | null | undefined,
  context: FeedbackExtractionContext,
): boolean {
  const respondent = context.respondentDisplayName?.trim();
  const mentioned = mentionedName?.trim();
  if (!respondent || !mentioned) {
    return false;
  }
  return foldedTextContainsAtWordStart(
    foldPostEventFeedbackText(mentioned),
    foldPostEventFeedbackText(respondent),
  );
}
