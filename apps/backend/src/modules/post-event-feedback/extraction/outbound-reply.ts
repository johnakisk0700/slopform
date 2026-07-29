import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";

import { RESPONDENT_SOURCE_SAFETY_CATEGORIES } from "../attention.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type { FeedbackExtractionRejectionReason } from "./extraction.schemas.js";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  POST_EVENT_FEEDBACK_HOSTILITY_STOP_REPLY,
  POST_EVENT_FEEDBACK_SAFETY_ASSURANCE,
  createFeedbackClosingDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackHostilityStopDedupeKey,
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
 * The same idea one scope up: a refused *skip* leaves a goal open that the model
 * believed it had closed, so the reply it wrote has moved on and this run has to
 * ask the question itself.
 *
 * It cannot be left to the ordinary "model skipped ahead" branch below, because
 * that branch needs the model to have written a question-shaped reply. The
 * proposal that declines `liked` while recording `meet_again` is usually the one
 * that also says `nextGoal: null` with a thank-you or nothing at all, and then
 * the goal stays open with nobody asking it until tomorrow's reminder.
 */
const ACTIONABLE_GOAL_REFUSALS: ReadonlySet<FeedbackExtractionRejectionReason> =
  new Set(["declined_before_asked"]);

/**
 * At most one outbound per run, chosen deterministically rather than by the
 * model. Completion, safety and "what actually survived validation" are
 * application decisions with their own copy; only the ordinary case where the
 * recorded ladder still agrees with the model forwards its text.
 *
 * `testimonySeq` is the last participant message's `seq` — the replay-stable
 * anchor for the dedupe key.
 *
 * `closingNow` is the decision that the ladder has finished, not yet the choice
 * of ending copy — the caller withholds it when this run produced safety
 * signals, even if every goal is terminal, because ranking completion above a
 * disclosure thanked someone who had just described being grabbed and closed
 * the door on them. Which ending it earns is decided here: `copy.closing` when
 * something was recorded, `copy.declined` when nothing was **and** the model
 * wrote no goodbye of its own, and the model's own words whenever it did write
 * one.
 *
 * `stoppingForHostility` outranks everything, including the urgent-safety
 * silence — see the first branch for why that ordering is safe.
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
  stoppingForHostility = false,
): OutboundReply | undefined {
  // Ahead of every other branch, including the urgent-safety silence, because
  // this run has already established that no safety signal exists — that is a
  // precondition of `stoppingForHostility` and not a coincidence. Below this
  // point every branch is about continuing the questionnaire in some form, and
  // the one thing this run must not do is continue it.
  if (stoppingForHostility) {
    return {
      body: POST_EVENT_FEEDBACK_HOSTILITY_STOP_REPLY,
      dedupeKey: createFeedbackHostilityStopDedupeKey(conversation._id),
    };
  }
  return chooseOutbound(
    conversation,
    validated,
    closingNow,
    urgentSafety,
    testimonySeq,
    copy,
    nextOpenGoal,
  );
}

/**
 * Tell somebody who has just disclosed something that it reached a person.
 *
 * Applied by the caller rather than inside `resolveOutbound`, because it is not
 * a choice between copies: whatever this run decided to say, the application is
 * adding a promise of its own on top of it.
 *
 * Three things withhold the sentence.
 *
 * **Nothing was actually described yet.** Νίτσα Κομποσερογιάννη wrote that the
 * end of the evening had left her feeling bad and «αν θέλετε, μπορώ να σας πω τι
 * έγινε», and got «πες μου τι έγινε — σε ακούμε. Το προώθησα ήδη στην ομάδα
 * μας.» We had forwarded nothing; there was nothing to forward. Then she
 * described being pressed for a lift home after saying no twice — and that turn,
 * the one an operator actually needs, was answered with no assurance at all,
 * because the conversation was by then already flagged. So the gate is the
 * classifier's `incidentDescribed`, and a run only earns the line if a signal
 * that is *not* respondent-source cites a message which says what happened.
 *
 * **We have already said it.** Read off the transcript rather than off
 * `needsAttention`, which was the proxy that produced the bug above: a
 * conversation can be flagged for an unattributable note, or for an
 * announcement, without anybody ever having been promised anything. The
 * transcript answers the question actually being asked — did this sentence reach
 * their phone — and it answers it correctly when a reply was withheld as
 * superseded, where a flag set at compute time would have lied.
 *
 * **The run is answering the person who is the incident.** The line was written
 * for Ειρήνη Καταγγελού, who described being touched without consent. Sent to
 * Γεωργία Ρατσιστρόνα it tells the person who *is* the incident that her racism
 * reached the team and somebody will speak to her personally — worse than saying
 * nothing, and a promise about a conversation staff have not agreed to have. A
 * burst carrying a disclosure as well still earns it: there is somebody in it to
 * reassure. The handoff copy is left alone throughout; it says the same thing in
 * its own words.
 */
export function withSafetyAssurance(
  conversation: FeedbackConversationDocument,
  validated: FeedbackExtractionValidationResult,
  outbound: OutboundReply | undefined,
  describedIncidentMessageIds: ReadonlySet<string>,
): OutboundReply | undefined {
  const describesSomethingToForward = validated.safetySignals.some(
    (signal) =>
      !RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(signal.category) &&
      signal.sourceMessageIds.some((messageId) =>
        describedIncidentMessageIds.has(messageId),
      ),
  );
  if (
    !outbound ||
    !describesSomethingToForward ||
    validated.handoff ||
    alreadyAssured(conversation)
  ) {
    return outbound;
  }
  return {
    ...outbound,
    body: `${outbound.body}\n\n${POST_EVENT_FEEDBACK_SAFETY_ASSURANCE}`,
  };
}

/**
 * Whether this sentence has already reached the participant's phone.
 *
 * Substring rather than equality because the assurance is appended to whatever
 * the run was already saying. If the copy is ever reworded, a conversation
 * mid-flight can hear the new wording once more; that is the right way round.
 */
function alreadyAssured(conversation: FeedbackConversationDocument): boolean {
  return conversation.messages.some(
    (message) =>
      message.actor === "bot" &&
      message.text.includes(POST_EVENT_FEEDBACK_SAFETY_ASSURANCE),
  );
}

function chooseOutbound(
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
  // «Τέλεια, ευχαριστούμε πολύ!» thanks somebody for what they told us. When
  // the ladder finished without a single answer in it, there is nothing to
  // thank them for, and Μπάμπης Διπλογαμωσταυρίδης got exactly that line back
  // for «άντε γαμήσου ρε μαλακισμένο μποτ» — the model had declined every goal
  // on his first message, completion swapped in the campaign copy, and the one
  // thing the model actually wrote for him was thrown away. Where nothing was
  // recorded, the bot's own words are the honest ending.
  if (closingNow && answeredAnything(conversation, validated)) {
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
  // guaranteed to still be true. A refused *skip* is the same lie told about a
  // question the bot never asked, so it takes the same route.
  const refused = refusedQuestionKey(validated);
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
    // The other half of the empty-ladder ending, and only where there would
    // otherwise be nothing at all. Withholding the thank-you above was right and
    // left a hole behind it: Πάνος Μούλαρος wrote «δε λεω τιποτα» three times,
    // the model declined all four goals and wrote no reply, and the only message
    // he ever received was the intro — while the conversation closed in the same
    // breath, so whatever he wrote next would reach nobody.
    //
    // Below the model's own words on purpose. Μπάμπης's «Δίκαιο — το
    // ερωτηματολόγιο μόλις έφαγε πόρτα 😅» is a better goodbye than any fixed
    // sentence, and it is exactly the line an earlier version of this function
    // threw away. Our copy fills a silence; it does not replace a reply.
    //
    // The closing dedupe key, because this is the conversation's one ending
    // message and the two endings are mutually exclusive by construction.
    return closingNow
      ? {
          body: copy.declined,
          dedupeKey: createFeedbackClosingDedupeKey(conversation._id),
        }
      : undefined;
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

/**
 * Whether this conversation ever got an answer out of the participant —
 * previously recorded, or accepted in this run.
 *
 * Exported because the close decision needs the same judgement the closing copy
 * needs, and for the same reason: «Τέλεια, ευχαριστούμε πολύ!» has nothing to
 * thank an empty ladder for, and `lifecycle.reason: "completed"` has no
 * questionnaire to call finished. One definition, so the sentence the
 * participant reads and the word the database records can never disagree.
 */
export function answeredAnything(
  conversation: FeedbackConversationDocument,
  validated: FeedbackExtractionValidationResult,
): boolean {
  return (
    validated.answers.length > 0 ||
    conversation.goals.some((goal) => goal.status === "answered")
  );
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
 * The question this run refused to settle, if any — an answer it could not use,
 * or a skip it would not accept.
 *
 * Only refusals the participant can act on count, and when several land in one
 * run the earliest questionnaire goal wins — re-asking `avoid` while `liked`
 * is still open is how a refused name quietly advances the ladder.
 */
function refusedQuestionKey(
  validated: FeedbackExtractionValidationResult,
): FeedbackAnswerQuestionKey | undefined {
  const refused = new Set<FeedbackAnswerQuestionKey>();
  for (const rejection of validated.rejections) {
    const actionable =
      rejection.scope === "answer"
        ? ACTIONABLE_ANSWER_REFUSALS.has(rejection.reason)
        : rejection.scope === "goal" &&
          ACTIONABLE_GOAL_REFUSALS.has(rejection.reason);
    if (!actionable) {
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
