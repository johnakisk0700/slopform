import type { FeedbackAnswerQuestionKey } from "@slopform/database";

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
  postEventFeedbackReaskCopyKey,
  type PostEventFeedbackQuestionSetCopy,
} from "../question-set.js";
import {
  POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS,
  type FeedbackPolicyQuestionMatch,
} from "./policy-answers.js";
import {
  nextOpenGoal,
  settledGoalKeys,
  type GoalStatusUpdate,
} from "./goal-progress.js";

export interface OutboundReply {
  readonly body: string;
  readonly dedupeKey: string;
  /** True only when `body` came from the participant-facing model writer. */
  readonly generatedByModel?: true;
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
 * `recordedStatuses` are this run's recorded ladder updates — answers and skips
 * that actually survived validation, never the model's private belief. The
 * open-goal and settled-goal views both derive from them here, in one place,
 * because the two judgements that read them must not drift: the branch that
 * catches a model skipping ahead needs the earliest goal still owed, and the
 * refused re-ask needs to know which goals owe nothing — asking one of those
 * again is how Ρούλα Κομποσερίδου got the `liked` campaign copy twice over a
 * question she had answered two turns earlier (2026-08-01 paid rehearsal).
 * The model writes `nextGoal: null` and a thank-you when it believes every
 * answer landed; validation then drops the directed ones and the thank-you
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
  recordedStatuses: readonly GoalStatusUpdate[],
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
    recordedStatuses,
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
 * Answer a recognised data-handling question with the sentence we approved.
 *
 * The other half of rule 11στ. The rule is right that the model must never say
 * what we do with somebody's answers — but it left every such question with a
 * deferral, and Νίτσα Κομποσερογιάννη's «δεν θέλω να "κανονίζεται" κάτι χωρίς
 * να το ξέρω, ούτε να το μάθουν οι υπόλοιποι» was answered with the campaign's
 * cheerful thank-you. The classifier now names the question, and this appends
 * the approved sentence from `policy-answers.ts` — application copy, same text
 * every time, the same shape as `withSafetyAssurance` above and applied for the
 * same reason: it is not a choice between copies, it is a sentence of our own
 * added to whatever the run decided to say.
 *
 * The model's own deferral («μπορεί να σου απαντήσει άνθρωπος από την ομάδα»)
 * may precede the appended sentence in one message. That juxtaposition is
 * accepted, not accidental: the appended sentence *is* the team's pre-approved
 * answer, and rewording the model's reply to smooth the seam would mean
 * touching model text, which nothing in this module does.
 *
 * Three things withhold a sentence. **The question has no approved answer** —
 * retention and anonymity are recognised and deliberately unanswered; those earn
 * the deferral plus an `unanswered_data_question` reason so a person sees them.
 * **We have already said it** — read off the transcript by substring, exactly
 * like `alreadyAssured`, so asking twice gets the answer once. **There is no
 * outbound to append to** — a silenced run stays silent; the question is still
 * in the transcript and the conversation is still flagged where it matters.
 */
export function withPolicyAnswers(
  conversation: FeedbackConversationDocument,
  outbound: OutboundReply | undefined,
  policyQuestions: readonly FeedbackPolicyQuestionMatch[],
): OutboundReply | undefined {
  if (!outbound || policyQuestions.length === 0) {
    return outbound;
  }
  const additions: string[] = [];
  const appended = new Set<string>();
  for (const { question } of policyQuestions) {
    const answer =
      POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS[question].answer;
    if (answer === null || appended.has(question)) {
      continue;
    }
    appended.add(question);
    if (!alreadySaid(conversation, answer)) {
      additions.push(answer);
    }
  }
  if (additions.length === 0) {
    return outbound;
  }
  return {
    ...outbound,
    body: [outbound.body, ...additions].join("\n\n"),
  };
}

/** A run's outbound after the re-ask cap has had its say. */
export interface CappedOutbound {
  readonly outbound: OutboundReply | undefined;
  /**
   * The bot message an operator should open when the cap withheld this run's
   * question: the last time the goal's re-ask variant went out — the message
   * that spent the final wording. `null` whenever nothing was withheld.
   *
   * A *bot* message rather than the participant's newest one, and that is
   * load-bearing rather than cosmetic. The anchor is what makes the raise
   * idempotent across runs — `raiseAttention` dedupes on kind plus message —
   * and every new participant message mints a new id, so anchoring on the
   * newest testimony would file one identical reason per turn for as long as
   * the person kept typing. The message that already carried the copy does not
   * move, and it is also the one that shows the operator what happened.
   */
  readonly stalledOnMessageId: string | null;
}

/**
 * Never send a question in words this conversation has already heard.
 *
 * The model's own re-asks vary — rule 11δ forbids repeating a question in the
 * same words, and the personas that get two differently worded re-asks are
 * fine. `questionOutbound` cannot vary on the fly: the campaign copy is
 * wording this path is guaranteed not to be lying with, which is exactly why
 * it is used and exactly why nothing here may improvise a rewording. What it
 * has instead is exactly one more approved wording per goal — the `_reask`
 * variant in the question set's copy — and the rule is one send per wording:
 * the question itself, then the variant, then nothing. This used to be a cap
 * of two sends of the *identical* body, on the theory that the second was
 * «you may not have seen this» — and the 2026-08-04 slot-2 rehearsal showed
 * what that theory looks like from the phone: a refused directed answer put
 * two byte-identical questions there ~70 seconds apart, which the burst
 * grader rightly files as `duplicate_outbound` and a participant reads as a
 * machine not listening. The re-ask was always legitimate; its wording was
 * the defect.
 *
 * The loop the stall closes is a real one, and it does not need a broken
 * model to happen. An unresolved mention banks no answer, the next open goal
 * therefore does not move, and `questionOutbound` re-sends the same goal —
 * while the dedupe key carries the testimony `seq`, so every new participant
 * message mints a fresh key and the outbox fence never fires. In paid
 * rehearsal runs 13 and 14 (2026-07-31) two guests were sent «Υπήρχε κάποιος
 * ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;» eleven and
 * eight times, one of them answering «re eipa idi 3 fores, i loyla!».
 *
 * Applied by the caller rather than inside `resolveOutbound`, for the same
 * reason `withSafetyAssurance` is: it is not a choice between copies. Whatever
 * this run decided to say, the application is refusing to say it in words
 * that already went out — and once both wordings are spent, the refusal owes
 * an operator an explanation, which is what the returned anchor is for. A
 * conversation that is out of ways to ask its next question is not one to
 * leave going quietly quiet.
 *
 * The judgement is over *identical bodies*, not over "this goal was asked
 * twice" — a differently worded ask is the behaviour we want and must survive
 * untouched — but the two sources of a repeat are checked against different
 * spans of the transcript. The campaign's fixed wording is checked against
 * the whole of it, because the grader's `duplicate_outbound` is over the
 * whole of it too: the identical question landing twice on one phone is a
 * defect even with an unrelated reply between the two sends. The model's own
 * words are checked against the last bot message only — a model that repeats
 * itself byte-for-byte right after itself is parroting the transcript rather
 * than asking, while a phrase resurfacing after the conversation moved on is
 * ordinary language. The planner's reminder nudge quotes the question inside
 * its own wrapper copy, so it is equal to neither wording and never counted.
 */
export function withCampaignReaskCap(
  conversation: FeedbackConversationDocument,
  outbound: OutboundReply | undefined,
  copy: PostEventFeedbackQuestionSetCopy,
): CappedOutbound {
  const goal = outbound?.askedGoal;
  // Only questions. Closings, handoffs and the model's non-question replies
  // carry no `askedGoal`, and none of them is a re-ask this path could reword.
  if (!outbound || !goal) {
    return { outbound, stalledOnMessageId: null };
  }
  const botMessages = conversation.messages.filter(
    (message) => message.actor === "bot",
  );
  const repeatsItself =
    outbound.body === copy[goal]
      ? botMessages.some((message) => message.text === outbound.body)
      : botMessages.at(-1)?.text === outbound.body;
  if (!repeatsItself) {
    return { outbound, stalledOnMessageId: null };
  }
  const variantSent = botMessages.filter(
    (message) => message.text === copy[postEventFeedbackReaskCopyKey(goal)],
  );
  if (variantSent.length === 0) {
    // The re-ask, in the one other wording this path owns. Application copy
    // replacing whatever repeated, so `generatedByModel` does not survive the
    // swap; the dedupe key does, because it is this run's reply either way.
    return {
      outbound: {
        body: copy[postEventFeedbackReaskCopyKey(goal)],
        dedupeKey: outbound.dedupeKey,
        askedGoal: goal,
      },
      stalledOnMessageId: null,
    };
  }
  return {
    outbound: undefined,
    stalledOnMessageId: variantSent.at(-1)?.id ?? null,
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
  return alreadySaid(conversation, POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);
}

/**
 * Whether one of our appended sentences has already reached this phone — the
 * safety assurance and the policy answers share the judgement, and both dedupe
 * by substring for the reason `alreadyAssured` documents: the sentence rides on
 * whatever the run was already saying.
 */
function alreadySaid(
  conversation: FeedbackConversationDocument,
  sentence: string,
): boolean {
  return conversation.messages.some(
    (message) => message.actor === "bot" && message.text.includes(sentence),
  );
}

function chooseOutbound(
  conversation: FeedbackConversationDocument,
  validated: FeedbackExtractionValidationResult,
  closingNow: boolean,
  urgentSafety: boolean,
  testimonySeq: number,
  copy: PostEventFeedbackQuestionSetCopy,
  recordedStatuses: readonly GoalStatusUpdate[],
): OutboundReply | undefined {
  const openGoal = nextOpenGoal(conversation.goals, recordedStatuses);
  const settled = settledGoalKeys(conversation.goals, recordedStatuses);
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
    // «Τέλεια! 🙌» is the right ending for an ordinary questionnaire and the
    // wrong one for a conversation that carries an open safety flag. Νίτσα
    // Κομποσερογιάννη disclosed being pressed for a lift home, asked three
    // serious questions about what happens next — and the last thing we sent
    // her was the cheerful thank-you, because `closingNow` only withholds the
    // ending from the run that *raises* a signal, not from the runs after it.
    // The flag itself is the memory: while a safety reason is unresolved, the
    // conversation closes in the register it was actually held in. Only the
    // `safety` kind — a `respondent_conduct` flag marks the person we are
    // thanking as the problem, and neither ending fits them; the ordinary one
    // at least promises nothing.
    const carriesOpenSafetyFlag = conversation.attentionReasons.some(
      (reason) => reason.kind === "safety" && reason.resolvedAt === null,
    );
    return {
      body: carriesOpenSafetyFlag ? copy.closing_after_safety : copy.closing,
      dedupeKey: createFeedbackClosingDedupeKey(conversation._id, testimonySeq),
    };
  }

  // The model wrote its reply believing its own proposal was accepted. When
  // validation then refused the answer, «Τέλεια, το σημείωσα!» is a straight
  // untruth: nothing was recorded, the participant believes the question is
  // behind them, and the score is lost with nobody aware. Ask the question
  // again instead — in the campaign's own words, which are the only ones here
  // guaranteed to still be true. A refused *skip* is the same lie told about a
  // question the bot never asked, so it takes the same route.
  const refused = refusedQuestionKey(validated, settled);
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
    openGoal &&
    validated.safetySignals.length === 0 &&
    ((validated.nextGoal !== null && validated.nextGoal !== openGoal) ||
      (validated.nextGoal === null && validated.reply && proposedProgress))
  ) {
    return questionOutbound(conversation._id, testimonySeq, copy, openGoal);
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
          dedupeKey: createFeedbackClosingDedupeKey(
            conversation._id,
            testimonySeq,
          ),
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
    generatedByModel: true,
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
 * An elliptical ask which names the small answer that is sufficient instead of
 * using a verb: «Ένα νούμερο 1 ως 5 φτάνει». Keep this deliberately narrower
 * than `φτάνει` / `αρκεί` alone — «φτάνει πια» is a bow-out, not a question.
 */
const ASKS_BY_SUFFICIENCY =
  /(?:^|[^\p{L}])(?:ένα|ενα|έναν|εναν|ένας|ενας|μία|μια)\s+(?:(?:μόνο|μονο|έστω|εστω)\s+)?(?:νούμερο|νουμερο|αριθμό|αριθμο|αριθμός|αριθμος|όνομα|ονομα|λέξη|λεξη)(?:\s+(?:(?:από|απο)\s+)?\d+\s*(?:ως|έως|εως|-)\s*\d+)?\s+(?:μου\s+)?(?:φτάνει|φτανει|αρκεί|αρκει)(?![\p{L}])/iu;

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
    ASKS_IN_THE_IMPERATIVE.test(body) ||
    ASKS_BY_SUFFICIENCY.test(body)
  );
}

/**
 * The question this run refused to settle, if any — an answer it could not use,
 * or a skip it would not accept.
 *
 * Only refusals the participant can act on count, and when several land in one
 * run the earliest questionnaire goal wins — re-asking `avoid` while `liked`
 * is still open is how a refused name quietly advances the ladder.
 *
 * A refusal on a goal that is already settled does not count at all. The lie
 * this path exists to prevent — «το σημείωσα!» over an answer that was not
 * recorded — is only a lie while the goal still owes an answer; once one is
 * banked, a refused mention is a *surplus*, and the campaign copy would restate
 * a question the participant has already answered. That is precisely what the
 * 2026-08-01T17-06-11Z rehearsal sent Ρούλα Κομποσερίδου: `liked` answered (η
 * Λούλα) since her first message, two more table neighbours resolving to
 * nobody, and the identical `liked` question twice — the re-ask cap stopped the
 * third, but the first two were never legitimate. The refused name still
 * reaches an operator: validation files it as an unattributable note, in the
 * place a person actually reads.
 */
function refusedQuestionKey(
  validated: FeedbackExtractionValidationResult,
  settled: ReadonlySet<FeedbackAnswerQuestionKey>,
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
    if (key && isPostEventFeedbackAnswerQuestionKey(key) && !settled.has(key)) {
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
