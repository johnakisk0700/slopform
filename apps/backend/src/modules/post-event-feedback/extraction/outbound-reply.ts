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
   * Goal this outbound is actually asking. Progress reads this, not `nextGoal`.
   */
  readonly askedGoal?: FeedbackAnswerQuestionKey;
}

/**
 * Refusals the participant can still repair if we ask again. Duplicates and
 * provenance faults are not.
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
 * A refused skip leaves a goal open that the model's reply has already left.
 * The skip-ahead branch needs a question-shaped reply; this path asks the
 * campaign question itself.
 */
const ACTIONABLE_GOAL_REFUSALS: ReadonlySet<FeedbackExtractionRejectionReason> =
  new Set(["declined_before_asked"]);

/**
 * At most one outbound per run. Application owns completion, safety and
 * validation-surviving copy; model text forwards only when the recorded ladder
 * still agrees. `testimonySeq` is the last participant `seq` (replay-stable
 * dedupe). `closingNow` is withheld when this run raised safety. Hostility
 * stop outranks every other branch. Open/settled goals derive from
 * `recordedStatuses` here so a thank-you cannot go out on an open ladder.
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
  // Hostility stop first. Precondition: no safety signal. Do not continue.
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
 * Append the application-owned assurance when a non-respondent-source signal
 * cites a described incident, the sentence is not already on the transcript,
 * and this run is not already using handoff copy. Caller-applied, not a copy
 * choice. Never send it to respondent-source-only abuse.
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
 * Append approved policy sentences. Unanswered ids stay deferred. Dedupes by
 * transcript substring. A silenced run stays silent — do not rewrite model text
 * to smooth the seam.
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
   * Bot message that spent the last re-ask wording, or null. Anchor on that
   * bot id so later participant turns do not mint duplicate reasons.
   */
  readonly stalledOnMessageId: string | null;
}

/**
 * One send per approved wording: campaign ask, then `_reask`, then nothing.
 * Campaign bodies are compared to the whole bot transcript; model-written
 * bodies only to the last bot message. Reminder wrappers never spend a wording.
 * Dedupes on testimony `seq`, so a stuck open goal would otherwise re-send
 * forever. After both wordings are spent, return the bot-message anchor.
 */
export function withCampaignReaskCap(
  conversation: FeedbackConversationDocument,
  outbound: OutboundReply | undefined,
  copy: PostEventFeedbackQuestionSetCopy,
): CappedOutbound {
  const goal = outbound?.askedGoal;
  // Only questions. Closings, handoffs and non-question replies have no ask.
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
    // Swap to the `_reask` wording. Drop `generatedByModel`; keep the dedupe key.
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

/** Substring match: the assurance is appended to whatever the run already said. */
function alreadyAssured(conversation: FeedbackConversationDocument): boolean {
  return alreadySaid(conversation, POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);
}

/** Shared transcript substring check for appended application sentences. */
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
  // Urgent safety with no handoff: send nothing. Questionnaire copy is wrong.
  if (urgentSafety && !validated.handoff) {
    return undefined;
  }
  if (validated.replySuppressedReason === "not_permitted") {
    return undefined;
  }

  // Explicit handoff only (D13). Safety raises attention; it does not swap copy.
  if (validated.handoff) {
    return {
      body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
      dedupeKey: createFeedbackHandoffDedupeKey(conversation._id, testimonySeq),
    };
  }
  // Thank-you only when something was recorded. Empty ladders keep model words.
  if (closingNow && answeredAnything(conversation, validated)) {
    // Unresolved `safety` uses `closing_after_safety`. `respondent_conduct`
    // keeps ordinary closing — neither ending fits, and this one promises nothing.
    const carriesOpenSafetyFlag = conversation.attentionReasons.some(
      (reason) => reason.kind === "safety" && reason.resolvedAt === null,
    );
    return {
      body: carriesOpenSafetyFlag ? copy.closing_after_safety : copy.closing,
      dedupeKey: createFeedbackClosingDedupeKey(conversation._id, testimonySeq),
    };
  }

  // Refused answer or skip: ask the campaign question. Model "noted it" is a lie.
  const refused = refusedQuestionKey(validated, settled);
  if (refused) {
    return questionOutbound(conversation._id, testimonySeq, copy, refused);
  }

  // Model skipped ahead or thanked on an unfinished recorded ladder: ask the
  // open goal. A bare `nextGoal: null` with no progress is a side-question
  // reply. Safety keeps the model's ordinary reply (D13).
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
    // Empty ladder with no model reply: send `copy.declined`. Never replace
    // model words. Closing dedupe key — mutually exclusive with `copy.closing`.
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

  // Forwarded model reply: `askedGoal` only when the words pose a question.
  // A withdrawal that still names a nextGoal must not mark that goal asked.
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
 * Whether any goal was ever answered (stored or this run). Closing copy and
 * `lifecycle.reason` share this so they cannot disagree.
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
 * Imperative ask without `?`/`;`. No `\b` — JS word boundaries are ASCII, so
 * use letter lookaround and do not match «πέρασες».
 */
const ASKS_IN_THE_IMPERATIVE =
  /(?:^|[^\p{L}])(?:πες|πεις|πεσ|στείλε|στειλε|γράψε|γραψε|πέτα|πετα|δώσε|δωσε|βάλε|βαλε|μοιράσου|ρίξε|ριξε)(?![\p{L}])/iu;

/**
 * Elliptical ask naming a sufficient small answer. Narrower than `φτάνει` /
 * `αρκεί` alone — «φτάνει πια» is a bow-out.
 */
const ASKS_BY_SUFFICIENCY =
  /(?:^|[^\p{L}])(?:ένα|ενα|έναν|εναν|ένας|ενας|μία|μια)\s+(?:(?:μόνο|μονο|έστω|εστω)\s+)?(?:νούμερο|νουμερο|αριθμό|αριθμο|αριθμός|αριθμος|όνομα|ονομα|λέξη|λεξη)(?:\s+(?:(?:από|απο)\s+)?\d+\s*(?:ως|έως|εως|-)\s*\d+)?\s+(?:μου\s+)?(?:φτάνει|φτανει|αρκεί|αρκει)(?![\p{L}])/iu;

/**
 * Whether the reply poses a question. Prefer false-positive "asked": missing
 * an ask trips `isWithdrawal` and settles the ladder.
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
 * Earliest actionable refused goal that is not already settled. A surplus
 * refusal on a banked goal must not restate that question.
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
