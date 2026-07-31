import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type {
  ValidatedFeedbackExtraction,
  ValidatedFeedbackSafetySignal,
} from "./extraction.schemas.js";
import {
  RESPONDENT_SOURCE_SAFETY_CATEGORIES,
  strongerRecommendedAction,
  type PostEventFeedbackAttentionReason,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "../attention.js";

/** One reason to raise, and the message an operator should be reading. */
export interface FeedbackOperatorAttentionRaise {
  readonly kind: PostEventFeedbackAttentionReason;
  readonly messageId: string | null;
}

/**
 * Why this run is putting a hostile conversation in front of a person.
 *
 * `stopped` is the ladder running out: the exit line has gone, the bot is now
 * silent, and the row is «somebody needs to close this by hand». `unanswerable`
 * is the earlier, quieter case — the model declined every remaining goal on a
 * hostile turn, so there is nothing left for the bot to ask and yet nothing was
 * ever recorded. Both are the same operator job, so they share the reason name;
 * they differ only in whether the bot has stopped talking, which is what the
 * distinction is carried for at the call site.
 */
export type FeedbackHostilityRaise = "none" | "stopped" | "unanswerable";

/**
 * How many hostile turns still earn a calm reply before the bot says the one
 * line and stops.
 *
 * Three, the top of the owner's «two or three», because the doubt is worth
 * spending on the participant: the commonest hostile opening is somebody
 * annoyed at being messaged at all, and two of the three people in the
 * rehearsal catalogue who start badly go on to answer the questionnaire. Three
 * also lands Μπάμπης Διπλογαμωσταυρίδης's four-cluster rehearsal exactly on the
 * exit line rather than one rung short of it, so the row measures the stop
 * instead of measuring the threshold.
 */
export const FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP = 3;

/**
 * Whether this run is the one where the bot says the exit line and goes quiet.
 *
 * Three conditions, and the second is the whole safety of the feature.
 *
 * `hostileTurn` — this run read hostility — is what keeps the stop an answer to
 * something rather than a standing state of the conversation. Without it, a
 * conversation already over the threshold would trip again on the next run
 * whatever it contained: an operator who takes the thread over, calms him down
 * and hands it back with `resumeBot` would watch the bot freeze it again on his
 * first civil message, because the counter is durable and never falls. The exit
 * line stays available for a genuine relapse — one more hostile turn trips it,
 * and the per-conversation dedupe key means he is still only told once.
 *
 * `hostileTurns` is the running total *including* this run, so the comparison is
 * strict: three hostile turns are answered, the fourth is not.
 *
 * `safetySignals` being empty is the guard. Ειρήνη Καταγγελού described being
 * touched at the table without her consent, in the plainest words anybody uses
 * for that, and those words score high on every measure of "heavy language" a
 * classifier has. If the exit line could ever reach her, the module would answer
 * a disclosure by refusing to talk to the person who made it and freezing her
 * conversation — the worst single message this system could send. So a run
 * carrying any safety signal cannot stop the conversation, and the counter above
 * does not tick on it either: the belt and the braces are separate on purpose,
 * because the counter protects the future runs and this protects this one.
 *
 * Nothing here consults the safety *categories*. `abuse_of_a_participant` is a
 * respondent-source category and it would be tempting to let it through, but the
 * person who degrades an attendee is exactly the person an operator has to
 * answer for, and D13 as amended already decided the bot keeps talking to them.
 */
export function stopsForHostility(input: {
  readonly hostileTurn: boolean;
  readonly hostileTurns: number;
  readonly safetySignalCount: number;
}): boolean {
  return (
    input.hostileTurn &&
    input.safetySignalCount === 0 &&
    input.hostileTurns > FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP
  );
}

/**
 * Whether this run counts as a hostile turn against the durable ladder.
 *
 * A run that produced safety signals is never a hostility turn, whatever the
 * classifier said about its tone. The reasoning is in `stopsForHostility`: the
 * counter is what carries a judgement between runs, so letting a disclosure
 * increment it would move the exit line towards somebody it must never reach.
 */
export function countsAsHostileTurn(input: {
  readonly hostileMessageIds: readonly string[];
  readonly safetySignalCount: number;
}): boolean {
  return input.safetySignalCount === 0 && input.hostileMessageIds.length > 0;
}

/**
 * Everything about this run that should surface in the admin inbox, named.
 *
 * This used to answer `true`, which is the whole defect: safety and handoff are
 * the incident path (D13), while a flagged subjectless note (D18) and a refused
 * answer revision are quieter inbox work — and all four arrived as one badge
 * that said nothing and could not be cleared, because there was nothing
 * specific enough to clear.
 *
 * Four of the seven carry no citation of their own. An explicit handoff is a
 * property of the run rather than of a line, a refused revision is about the
 * *stored* answer it disagreed with, a withdrawal is about the run deciding to
 * stop, and the hostility raise is about a ladder rather than a sentence; all
 * four are anchored on the newest message this run read, which is the burst an
 * operator wants open. That is a weaker claim than the safety anchor and
 * deliberately so — the alternative is a reason that links nowhere.
 *
 * `withdrew` is passed in rather than derived here because it depends on what
 * actually reached the phone, which only the run knows. It belongs in this list
 * all the same: a withdrawal used to raise the bare flag, so the one situation
 * where the bot gave up on a questionnaire was also the one an operator could
 * not read or dismiss.
 *
 * `stalledOnMessageId` arrives the same way and for the same reason, and it is
 * the one raise here anchored on something the *bot* said. It is not one of the
 * four above: the message it cites is the whole of the news — this exact
 * sentence, already sent as often as it may be.
 */
export function operatorAttentionRaises(
  validated: FeedbackExtractionValidationResult,
  newestParticipantMessageId: string | null,
  withdrew = false,
  hostility: FeedbackHostilityRaise = "none",
  stalledOnMessageId: string | null = null,
  unansweredDataQuestionMessageIds: readonly string[] = [],
): FeedbackOperatorAttentionRaise[] {
  const raises: FeedbackOperatorAttentionRaise[] = [];

  for (const attention of groupSafetySignalsByMessage(
    validated.safetySignals,
  )) {
    // Two different pieces of news, told apart by who the follow-up is about.
    // «A message raised a safety concern» is read as «somebody here may need
    // protecting», and putting Γεωργία's racism under that sentence sends an
    // operator in to look after the person who wrote it. Where every category
    // on the message is respondent-source the honest row is the conduct one and
    // only that; a burst that carries both a disclosure and abuse raises both,
    // because both are true and each is dismissed on its own.
    const respondentSource = attention.categories.some((category) =>
      RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(category),
    );
    if (respondentSource) {
      raises.push({
        kind: "respondent_conduct",
        messageId: attention.messageId,
      });
    }
    if (
      !attention.categories.every((category) =>
        RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(category),
      )
    ) {
      raises.push({ kind: "safety", messageId: attention.messageId });
    }
  }
  if (validated.handoff) {
    raises.push({ kind: "handoff", messageId: newestParticipantMessageId });
  }
  for (const note of validated.notes) {
    // D18 flags exactly the notes whose mention resolved to nobody, so the
    // note's own first citation is where the unattributable name was typed.
    if (note.flaggedForReview) {
      raises.push({
        kind: "unattributed_note",
        messageId: note.sourceMessageIds[0] ?? null,
      });
    }
  }
  if (validated.conflictingAnswerRevision) {
    raises.push({
      kind: "answer_revision",
      messageId: newestParticipantMessageId,
    });
  }
  // Named for the outcome an operator has to decide about — a questionnaire
  // that stopped short — rather than for the bot's decision to bow out. The two
  // are the same event; only one of them tells the operator what is on their
  // plate. Not `hostile_to_bot`: rule 7δ withdraws on silence, not on rudeness.
  if (withdrew) {
    raises.push({
      kind: "unfinished_questionnaire",
      messageId: newestParticipantMessageId,
    });
  }
  // `hostile_to_bot` finally has a producer, and it is deliberately the only
  // reason raised for this situation. The questionnaire is also unfinished and
  // the bot has also stopped asking, but «the participant was hostile to the
  // bot» is the one sentence that tells the operator what they are opening and
  // what to do about it — `staffClose.reason: "abusive"` — so a second row would
  // be the same news twice and two dismissals for one decision.
  if (hostility !== "none") {
    raises.push({
      kind: "hostile_to_bot",
      messageId: newestParticipantMessageId,
    });
  }
  // The re-ask cap has just refused to send this goal's campaign copy a third
  // time, so the bot has stopped asking a question nobody has answered — which
  // is `unfinished_questionnaire`'s documented meaning, word for word, and the
  // reason an operator would want here whatever the code path that noticed. The
  // near neighbours all describe something else: `undelivered_message` is about
  // a message that failed on its way out rather than one we chose not to write,
  // `hostile_to_bot` is about how the participant behaved, and `handoff` is a
  // promise we have not made. A new enum value would name the mechanism rather
  // than the operator's job — read the vocabulary's own rule — and the job here
  // is identical to a withdrawal's: read it, and either answer them yourself or
  // close it.
  //
  // Anchored on the bot message that already carried the copy, not on the
  // newest testimony, so the reason is recorded once rather than once per
  // message the participant goes on to send. See `CappedOutbound`.
  if (stalledOnMessageId) {
    raises.push({
      kind: "unfinished_questionnaire",
      messageId: stalledOnMessageId,
    });
  }
  // A data-handling question we recognised and have decided not to answer yet
  // — retention, anonymity, or one that matched no entry. The participant got
  // the model's deferral; this row is what stops the question dying there.
  // Anchored on the message that asked it, which makes the raise idempotent
  // across replays the same way the safety anchor is, and one row per asking
  // message rather than one per question: the operator reads the message, not
  // the taxonomy.
  for (const messageId of unansweredDataQuestionMessageIds) {
    raises.push({ kind: "unanswered_data_question", messageId });
  }

  return raises;
}

/**
 * The messages in this run where the person writing to us is the one doing the
 * harm — the citations an answer must not be honoured on.
 *
 * An answer row is written with `matching_hold` when it cites one of these.
 * Γεωργία answered `avoid` about an attendee she named because she does not sit
 * with foreigners, and both the answer and the abuse are the same sentence, so
 * the citation is what ties them together: no other link between a safety signal
 * and an answer row exists, and the run is the only place both are in hand.
 *
 * The narrowness is deliberate and it is a real limit. Abuse arriving in a later
 * burst than the answer it explains leaves the earlier row unheld, because
 * nothing in a run knows which stored answers a new message was about; what the
 * operator gets there is the `respondent_conduct` reason on the message, and
 * withdrawing the row is the only action. Widening this to "every answer in the
 * conversation" would hold answers about people the abuse had nothing to do
 * with, which is a different unfairness.
 */
export function respondentSourceMessageIds(
  signals: readonly ValidatedFeedbackSafetySignal[],
): ReadonlySet<string> {
  const held = new Set<string>();
  for (const signal of signals) {
    if (RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(signal.category)) {
      for (const messageId of signal.sourceMessageIds) {
        held.add(messageId);
      }
    }
  }
  return held;
}

export function isSafetyOrHandoffAttention(
  validated: ValidatedFeedbackExtraction,
): boolean {
  return validated.safetySignals.length > 0 || validated.handoff;
}

interface GroupedMessageAttention {
  readonly messageId: string;
  readonly categories: readonly PostEventFeedbackSafetyCategory[];
  readonly recommendedAction: PostEventFeedbackRecommendedAction;
  readonly confidence: number;
}

export function groupSafetySignalsByMessage(
  signals: readonly ValidatedFeedbackSafetySignal[],
): GroupedMessageAttention[] {
  const grouped = new Map<
    string,
    {
      categories: Set<PostEventFeedbackSafetyCategory>;
      recommendedAction: PostEventFeedbackRecommendedAction;
      confidence: number;
    }
  >();

  for (const signal of signals) {
    for (const messageId of signal.sourceMessageIds) {
      const current = grouped.get(messageId);
      if (current) {
        current.categories.add(signal.category);
        current.recommendedAction = strongerRecommendedAction(
          current.recommendedAction,
          signal.recommendedAction,
        );
        current.confidence = Math.max(current.confidence, signal.confidence);
      } else {
        grouped.set(messageId, {
          categories: new Set([signal.category]),
          recommendedAction: signal.recommendedAction,
          confidence: signal.confidence,
        });
      }
    }
  }

  return [...grouped.entries()].map(([messageId, attention]) => ({
    messageId,
    categories: [...attention.categories],
    recommendedAction: attention.recommendedAction,
    confidence: attention.confidence,
  }));
}
