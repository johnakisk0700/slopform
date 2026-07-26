import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";

import type { FeedbackConversationDocument } from "../../conversations/feedback-conversation.schemas.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  createFeedbackClosingDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackReplyDedupeKey,
} from "./extraction.schemas.js";
import {
  isPostEventFeedbackAnswerQuestionKey,
  type PostEventFeedbackQuestionSetCopy,
} from "../question-set.js";

export interface OutboundReply {
  readonly body: string;
  readonly dedupeKey: string;
}

/**
 * At most one outbound per run, chosen deterministically rather than by the
 * model. Completion and safety are application decisions with their own copy;
 * only the ordinary case forwards the model's text.
 *
 * `testimonySeq` is the last participant message's `seq` — the replay-stable
 * anchor for the dedupe key.
 *
 * `closingNow` is already the decision to send the closing copy — the caller
 * withholds it when this run produced safety signals, even if every goal is
 * terminal. Ranking completion above a disclosure thanked someone who had
 * just described being grabbed and closed the door on them.
 */
export function resolveOutbound(
  conversation: FeedbackConversationDocument,
  validated: FeedbackExtractionValidationResult,
  closingNow: boolean,
  urgentSafety: boolean,
  testimonySeq: number,
  copy: PostEventFeedbackQuestionSetCopy,
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
  if (!validated.reply && !closingNow && !validated.handoff) {
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
    return {
      body: copy[refused],
      dedupeKey: createFeedbackReplyDedupeKey(conversation._id, testimonySeq),
    };
  }

  return validated.reply
    ? {
        body: validated.reply,
        dedupeKey: createFeedbackReplyDedupeKey(conversation._id, testimonySeq),
      }
    : undefined;
}

/**
 * The question whose answer this run refused for being unusable, if any.
 *
 * Only refusals the participant can act on count. An `already_recorded`
 * duplicate or an unresolvable name needs no second attempt from them, while an
 * out-of-range score or a missing subject does — and re-asking is the only way
 * they ever find out we did not take it.
 */
function refusedAnswerQuestionKey(
  validated: FeedbackExtractionValidationResult,
): FeedbackAnswerQuestionKey | undefined {
  const actionable = validated.rejections.find(
    (rejection) =>
      rejection.scope === "answer" &&
      (rejection.reason === "invalid_score" ||
        rejection.reason === "missing_subject"),
  );
  const key = actionable?.questionKey;
  return key && isPostEventFeedbackAnswerQuestionKey(key)
    ? (key as FeedbackAnswerQuestionKey)
    : undefined;
}
