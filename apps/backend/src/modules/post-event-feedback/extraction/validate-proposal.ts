import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";
import { resolvePostEventFeedbackCandidateByName } from "../matching/candidate-name.js";
import {
  foldPostEventFeedbackText,
  foldedTextContainsAtWordStart,
} from "../matching/fold-text.js";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
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
 * The whole domain rule set for an extraction run, as one pure function.
 *
 * Nothing here reads a store, calls a provider or writes anything. That is the
 * point: the model's proposal is data until these rules accept it, and the same
 * rules can be replayed offline against the WP0 fixtures. The caller persists
 * only what comes back from here.
 *
 * The rules, in the order the plan states them (§7):
 *
 * 1. source messages must exist in *this* conversation and belong to this run;
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
 * pane, and the participant's own words survived nowhere. `safetySignals` now
 * raise attention (the extractor's job) without editing what is recorded.
 */
export type FeedbackExtractionValidationResult = ValidatedFeedbackExtraction & {
  /**
   * An `already_recorded` answer was proposed again with a **different** value
   * than the stored row. The row is not updated (immutability is deliberate
   * elsewhere); the extractor raises `needsAttention` so a human can reconcile.
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

  const verdicts = splitGoalVerdicts(proposal.goals, rejections);
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
    rejections,
  );

  const nextGoal = resolveNextGoal(proposal.nextGoal, context);
  const trimmedReply = proposal.reply?.trim() ?? "";
  const reply =
    context.replyAllowed && trimmedReply.length > 0 ? trimmedReply : null;

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
    handoff: proposal.handoff,
    confidence: proposal.confidence,
    rejections,
    conflictingAnswerRevision: answersResult.conflictingAnswerRevision,
  };
}

/**
 * Turns the per-goal verdicts back into the two lists the rules below already
 * know how to judge.
 *
 * The wire shape changed to stop the model omitting goals; the rules did not
 * need to change with it, because an `answered` verdict carries exactly the
 * fields an answer proposal always carried. `not_addressed` and
 * `already_settled` produce nothing at all — they are the model saying it
 * looked, which is worth requiring and nothing to record.
 */
function splitGoalVerdicts(
  goals: FeedbackExtractionProposal["goals"],
  rejections: FeedbackExtractionRejection[],
): {
  readonly answers: FeedbackExtractionAnswerProposal[];
  readonly declined: FeedbackAnswerQuestionKey[];
} {
  const answers: FeedbackExtractionAnswerProposal[] = [];
  const declined: FeedbackAnswerQuestionKey[] = [];

  for (const [key, verdict] of Object.entries(goals) as [
    FeedbackAnswerQuestionKey,
    FeedbackExtractionProposal["goals"][FeedbackAnswerQuestionKey],
  ][]) {
    if (verdict.status === "answered") {
      // The check the union would have made unnecessary. Claiming a goal is
      // answered and attaching nothing is not an answer, and saying so is the
      // difference between a visible fault and a goal that quietly stays open.
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

    if (!isPostEventFeedbackAnswerQuestionKey(proposal.questionKey)) {
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
      //
      // One rescue before dropping it: the name may be the same name in the
      // other alphabet. «o nikos gamatos» is ordinary Greek WhatsApp, and
      // comparing raw strings threw away every directed answer a Greeklish
      // typist gave us. The transliteration match resolves only when exactly
      // one candidate fits, so it widens who we recognise without ever choosing
      // between two of them.
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

      // A repeat of the same value says nothing new, whether it is a replay or
      // somebody typing «5» twice.
      if (previousValue === valueInt) {
        reject(stored ? "already_recorded" : "duplicate_in_run");
        continue;
      }

      // A *different* value for the same question is a revision, and the
      // participant meant the newer one — «βασικά 2, το ξανασκέφτηκα», or a
      // single message that lands on a number after changing its mind twice.
      // Dropping it left staff reading the first answer while the bot had
      // already said it changed it.
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

    // D18: an unresolvable subject degrades to a subjectless note that keeps
    // the name in its text and is flagged for review. It never becomes a
    // guessed participant id.
    // Same transliteration rescue as the answers path, so a Greeklish note
    // about a candidate keeps its subject instead of degrading.
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
    // Talking about themselves is not a failure to find anybody. «η πιο βαρετή
    // η Μαρία. εγώ δλδ 😂» resolves perfectly — to the respondent, about whom
    // no directed row may be written — so the joke becomes a subjectless note
    // and stops there. Flagging it put the respondent's own name in the admin's
    // "we could not find this person" column, which is simply untrue and sends
    // somebody looking for a participant who is already on the screen.
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
      // `feedback_notes` has no natural unique key, so this content signature is
      // the note's replay guard together with the extraction cursor.
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
 * D3 locks every question as skippable. D16 forbids reopening an answered goal,
 * and the same reasoning forbids retroactively skipping one.
 */
function validateSkippedGoals(
  proposals: readonly FeedbackAnswerQuestionKey[],
  context: FeedbackExtractionContext,
  answeredKeys: ReadonlySet<FeedbackAnswerQuestionKey>,
  rejections: FeedbackExtractionRejection[],
): FeedbackAnswerQuestionKey[] {
  const goalKeys = new Set(context.goals.map((goal) => goal.key));
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
    if (!skipped.includes(key)) {
      skipped.push(key);
    }
  }

  return skipped;
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
 * Provenance is the first gate for both answers and notes. Every referenced
 * message must exist in this conversation and be the participant's own words —
 * bot and staff turns are context, never testimony. Beyond that, **at least
 * one** reference must fall inside the current cursor window.
 *
 * That last rule used to demand that *every* reference be new, and it silently
 * ate testimony split across a cursor boundary. WhatsApp is typed, so «τον Νίκο
 * τον βρήκα» / «πολύ καλό, 5» is one ordinary thought. The window that finally
 * carries the score cites both halves, because that is honestly where the score
 * came from — and the whole answer was rejected for saying so, while the same
 * answer citing only the second half passed. The rule punished accurate
 * citation and lost the participant's own words.
 *
 * Requiring one new reference keeps what the rule was actually for: no result
 * may be born without new testimony driving it, so a run cannot spontaneously
 * re-mine the old transcript. Re-extraction of something already stored is a
 * different concern and is already refused twice over — by `already_recorded`
 * here, and by the answer unique constraint and the note content signature in
 * the locked transaction that writes them.
 *
 * The older half stays in `sourceMessageIds`, which is the point: an operator
 * reading the row sees the whole thought rather than its second half.
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

function answerDefinition(
  key: FeedbackAnswerQuestionKey,
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

/**
 * Whether a mentioned subject name is the respondent's own.
 *
 * Folded through the same comparison the STOP matcher uses, so accents,
 * casing and punctuation do not decide it. Left-anchored containment rather
 * than equality, because Greek inflects and people write «η Μαρία» where the
 * profile says «Μαρία».
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
