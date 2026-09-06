import type { FeedbackCampaignRow } from "@slopform/database";

import { isFeedbackClosingDedupeKey } from "../extraction/extraction.schemas.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { createFeedbackStopAckDedupeKey } from "../question-set.js";
import type { FeedbackOutboxClaimedRow } from "./outbox.types.js";

export type DispatchSettlementAction =
  "finish_failed" | "finish_cancelled" | "release";

export type DispatchPolicySettle = {
  readonly state: "settle";
  readonly action: DispatchSettlementAction;
  readonly reason: string;
};

export type DispatchConversationContinue = {
  readonly state: "continue";
  readonly permittedStopAcknowledgement: boolean;
  readonly permittedTerminalMessage: boolean;
};

type ConversationDispatchClaim = Pick<
  FeedbackOutboxClaimedRow,
  "id" | "conversationId" | "kind" | "dedupeKey"
>;

type ConversationDispatchConversation = Pick<
  FeedbackConversationDocument,
  "phoneAtLaunch" | "lifecycle" | "control"
>;

/**
 * Pre-consent conversation, campaign and terminal gates. Campaign/conversation
 * presence and later consent, awaiting-human and ordinary-reply currency stay
 * with the dispatcher so their reads keep the current order.
 */
export function evaluateConversationDispatch(input: {
  readonly claim: ConversationDispatchClaim;
  readonly campaign: Pick<FeedbackCampaignRow, "status">;
  readonly conversation: ConversationDispatchConversation;
  readonly lockedPhoneAtLaunch?: string;
}): DispatchPolicySettle | DispatchConversationContinue {
  const { claim, campaign, conversation, lockedPhoneAtLaunch } = input;

  if (
    lockedPhoneAtLaunch !== undefined &&
    conversation.phoneAtLaunch !== lockedPhoneAtLaunch
  ) {
    return {
      state: "settle",
      action: "finish_failed",
      reason: "conversation_route_changed",
    };
  }

  if (
    conversation.lifecycle.state === "open" &&
    isCanonicalTerminalTransitionMessage(claim)
  ) {
    return {
      state: "settle",
      action: "release",
      reason: "terminal_transition_pending",
    };
  }

  const permittedStopAcknowledgement =
    conversation.lifecycle.state === "closed" &&
    isPermittedStopAcknowledgement(
      claim,
      conversation.lifecycle.reason,
      conversation.lifecycle.terminalOutboxId,
    );
  const permittedTerminalMessage =
    conversation.lifecycle.state === "closed" &&
    isPermittedTerminalMessage(
      claim,
      conversation.lifecycle.reason,
      conversation.lifecycle.terminalOutboxId,
    );

  if (campaign.status === "closed" && !permittedStopAcknowledgement) {
    return {
      state: "settle",
      action: "finish_cancelled",
      reason: "campaign_closed",
    };
  }

  if (campaign.status === "paused" && !permittedStopAcknowledgement) {
    return {
      state: "settle",
      action: "release",
      reason: "campaign_paused",
    };
  }

  if (conversation.lifecycle.state === "closed" && !permittedTerminalMessage) {
    return {
      state: "settle",
      action: "finish_cancelled",
      reason: `conversation_closed:${conversation.lifecycle.reason ?? "unknown"}`,
    };
  }

  if (
    claim.kind !== "staff" &&
    !permittedTerminalMessage &&
    conversation.control.mode === "human"
  ) {
    return {
      state: "settle",
      action: "finish_cancelled",
      reason: "human_control",
    };
  }

  return {
    state: "continue",
    permittedStopAcknowledgement,
    permittedTerminalMessage,
  };
}

/**
 * Closing copy is written before the aggregate closes and therefore dispatches
 * afterward. STOP acknowledgement is the analogous `system` row. Every other
 * row is stale once the conversation is terminal.
 */
function isPermittedTerminalMessage(
  row: Pick<
    FeedbackOutboxClaimedRow,
    "id" | "conversationId" | "kind" | "dedupeKey"
  >,
  reason: string | null,
  terminalOutboxId: string | null | undefined,
): boolean {
  if (isPermittedStopAcknowledgement(row, reason, terminalOutboxId)) {
    return true;
  }
  if (reason === "completed" || reason === "declined") {
    return (
      row.kind === "reply" &&
      terminalOutboxId === row.id &&
      isFeedbackClosingDedupeKey(row.conversationId, row.dedupeKey)
    );
  }
  return false;
}

function isCanonicalTerminalTransitionMessage(
  row: Pick<FeedbackOutboxClaimedRow, "conversationId" | "kind" | "dedupeKey">,
): boolean {
  return (
    (row.kind === "reply" &&
      isFeedbackClosingDedupeKey(row.conversationId, row.dedupeKey)) ||
    (row.kind === "system" &&
      row.dedupeKey === createFeedbackStopAckDedupeKey(row.conversationId))
  );
}

function isPermittedStopAcknowledgement(
  row: Pick<
    FeedbackOutboxClaimedRow,
    "id" | "conversationId" | "kind" | "dedupeKey"
  >,
  reason: string | null,
  terminalOutboxId: string | null | undefined,
): boolean {
  return (
    reason === "stopped" &&
    row.kind === "system" &&
    terminalOutboxId === row.id &&
    row.dedupeKey === createFeedbackStopAckDedupeKey(row.conversationId)
  );
}
