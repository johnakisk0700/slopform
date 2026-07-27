import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";

import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type { FeedbackExtractionRejectionReason } from "./extraction.schemas.js";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  createFeedbackClosingDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackReplyDedupeKey,
} from "./extraction.schemas.js";
import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  isPostEventFeedbackAnswerQuestionKey,
  type PostEventFeedbackQuestionSetCopy,
} from "../question-set.js";

export interface OutboundReply {
  readonly body: string;
  readonly dedupeKey: string;
  /**
   * The goal this outbound is actually asking, when it is a question. Goal
   * progress reads this rather than the model's `nextGoal`, so a replaced reply
   * cannot mark a later question as asked while the participant is still being
   * asked the one validation refused.
   */
  readonly askedGoal?: FeedbackAnswerQuestionKey;
}

/**
 * Reasons where the participant can still give us a usable answer if we ask
 * again. Duplicates and provenance faults are not theirs to repair from a
 * second prompt; an out-of-range score or a name we could not place is.
 */
const ACTIONABLE_ANSWER_REFUSALS: ReadonlySet<FeedbackExtractionRejectionReason> =
  new Set([
    "invalid_score",
    "missing_subject",
    "unresolved_subject",
    "subject_is_respondent",
    "subject_on_subjectless_question",
    "empty_answered_verdict",
  ]);

/**
 * At most one outbound per run, chosen deterministically rather than by the
 * model. Completion, safety and "what actually survived validation" are
 * application decisions with their own copy; only the ordinary case where the
 * recorded ladder still agrees with the model forwards its text.
 *
 * `testimonySeq` is the last participant message's `seq` — the replay-stable
 * anchor for the dedupe key.
 *
 * `closingNow` is already the decision to send the closing copy — the caller
 * withholds it when this run produced safety signals, even if every goal is
 * terminal. Ranking completion above a disclosure thanked someone who had
 * just described being grabbed and closed the door on them.
 *
 * `nextOpenGoal` is the earliest goal still open after this run's *recorded*
 * updates. The model writes `nextGoal: null` and a thank-you when it believes
 * every answer landed; validation then drops the directed ones and the thank-you
 * would otherwise go out into a conversation that is still mid-questionnaire.
 * Closing copy is reserved for `closingNow`; an open ladder gets the open
 * question instead.
 */
export function resolveOutbound(
  conversation: FeedbackConversationDocument,
  validated: FeedbackExtractionValidationResult,
  closingNow: boolean,
  urgentSafety: boolean,
  testimonySeq: number,
  copy: PostEventFeedbackQuestionSetCopy,
  nextOpenGoal: FeedbackAnswerQuestionKey | null,
): OutboundReply | undefined {
  // Somebody has just said they do not want to live. There is no approved
  // copy for that, and every option the questionnaire owns is wrong: the next
  // question treats it as a lull in conversation, and the thank-you treats it
  // as an ending. Until a policy defines a safe reply, the bot says nothing
  // and the conversation goes to a person. An explicit handoff is the one
  // exception, because its copy says exactly that.
  if (urgentSafety && !validated.handoff) {
    return undefined;
  }
  if (validated.replySuppressedReason === "not_permitted") {
    return undefined;
  }

  // Only an *explicit* handoff swaps the copy. A safety signal no longer does
  // (D13, amended): forcing the neutral "someone will contact you" line ended
  // the questionnaire on the model's say-so, and the participant who had just
  // disclosed something got the most abrupt possible reply. Attention is
  // raised instead, and the conversation continues normally.
  if (validated.handoff) {
    return {
      body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
      dedupeKey: createFeedbackHandoffDedupeKey(conversation._id, testimonySeq),
    };
  }
  if (closingNow) {
    return {
      body: copy.closing,
      dedupeKey: createFeedbackClosingDedupeKey(conversation._id),
    };
  }

  // The model wrote its reply believing its own proposal was accepted. When
  // validation then refused the answer, «Τέλεια, το σημείωσα!» is a straight
  // untruth: nothing was recorded, the participant believes the question is
  // behind them, and the score is lost with nobody aware. Ask the question
  // again instead — in the campaign's own words, which are the only ones here
  // guaranteed to still be true.
  const refused = refusedAnswerQuestionKey(validated);
  if (refused) {
    return questionOutbound(conversation._id, testimonySeq, copy, refused);
  }

  // Recorded goals still owe an answer, but the model either named a later
  // goal while an earlier one is still open, or wrote a thank-you with
  // `nextGoal: null` after proposing answers/skips that did not actually finish
  // the ladder. Both are the model narrating a world validation refused.
  // A bare `nextGoal: null` reply with no answers, skips or answer-refusals is
  // left alone: that is how the bot answers a side question (flirting, "who
  // reads this") without claiming the questionnaire is done. Completion itself
  // is `closingNow`, which already keys off recorded goals only.
  // A safety signal is the further exception: D13 keeps the model's ordinary
  // reply so a disclosure is not answered with the next questionnaire prompt.
  const proposedProgress =
    validated.answers.length > 0 ||
    validated.skippedGoals.length > 0 ||
    validated.rejections.some((rejection) => rejection.scope === "answer");
  if (
    nextOpenGoal &&
    validated.safetySignals.length === 0 &&
    ((validated.nextGoal !== null && validated.nextGoal !== nextOpenGoal) ||
      (validated.nextGoal === null && validated.reply && proposedProgress))
  ) {
    return questionOutbound(conversation._id, testimonySeq, copy, nextOpenGoal);
  }

  if (!validated.reply) {
    return undefined;
  }

  // `nextGoal` is the model's private intent. A withdrawal that still names
  // liked — «ΟΚ, το πιάνω — το bot αποσύρεται…» — must not mark liked asked:
  // the next day's reminder_followup would restate a question nobody posed.
  // Campaign re-asks go through `questionOutbound` and always ask; a forwarded
  // reply only carries askedGoal when its own words pose a question.
  return {
    body: validated.reply,
    dedupeKey: createFeedbackReplyDedupeKey(conversation._id, testimonySeq),
    ...(validated.nextGoal && replyPosesQuestion(validated.reply)
      ? { askedGoal: validated.nextGoal }
      : {}),
  };
}

function questionOutbound(
  conversationId: string,
  testimonySeq: number,
  copy: PostEventFeedbackQuestionSetCopy,
  goal: FeedbackAnswerQuestionKey,
): OutboundReply {
  return {
    body: copy[goal],
    dedupeKey: createFeedbackReplyDedupeKey(conversationId, testimonySeq),
    askedGoal: goal,
  };
}

/**
 * The imperative the bot asks in when it does not use a question mark:
 * «πες μου έναν αριθμό από το 1 ως το 5.», «Πέτα μου μόνο έναν αριθμό», «στείλε
 * μου έστω έναν αριθμό». Six of the eight punctuation-free questions in the
 * last rehearsal were shaped like this, so reading them as statements is not a
 * rare edge.
 *
 * No `\b`: JavaScript word boundaries are defined on `[A-Za-z0-9_]`, so `\bπες`
 * never matches. The lookaround does the same job over letters of any script,
 * and keeps «πέρασες» from reading as an ask.
 */
const ASKS_IN_THE_IMPERATIVE =
  /(?:^|[^\p{L}])(?:πες|πεις|πεσ|στείλε|στειλε|γράψε|γραψε|πέτα|πετα|δώσε|δωσε|βάλε|βαλε|μοιράσου|ρίξε|ριξε)(?![\p{L}])/iu;

/**
 * Whether this reply's words are posing a question.
 *
 * Greek questions end with `;` (the Greek-keyboard question mark is ASCII
 * semicolon); Latin `?` shows up in mixed replies. Neither is required — see
 * above — and the doubt is deliberately spent towards "it asked". Both errors
 * are real, but they are not the same size: reading an ask as a statement now
 * also trips `isWithdrawal`, which settles every open goal and closes the
 * conversation, while reading a statement as an ask costs one restated
 * question in tomorrow's reminder.
 */
function replyPosesQuestion(body: string): boolean {
  return (
    body.includes("?") ||
    body.includes(";") ||
    ASKS_IN_THE_IMPERATIVE.test(body)
  );
}

/**
 * The question whose answer this run refused for being unusable, if any.
 *
 * Only refusals the participant can act on count, and when several land in one
 * run the earliest questionnaire goal wins — re-asking `avoid` while `liked`
 * is still open is how a refused name quietly advances the ladder.
 */
function refusedAnswerQuestionKey(
  validated: FeedbackExtractionValidationResult,
): FeedbackAnswerQuestionKey | undefined {
  const refused = new Set<FeedbackAnswerQuestionKey>();
  for (const rejection of validated.rejections) {
    if (
      rejection.scope !== "answer" ||
      !ACTIONABLE_ANSWER_REFUSALS.has(rejection.reason)
    ) {
      continue;
    }
    const key = rejection.questionKey;
    if (key && isPostEventFeedbackAnswerQuestionKey(key)) {
      refused.add(key);
    }
  }
  for (const key of FEEDBACK_ANSWER_QUESTION_KEYS) {
    if (refused.has(key)) {
      return key;
    }
  }
  return undefined;
}
