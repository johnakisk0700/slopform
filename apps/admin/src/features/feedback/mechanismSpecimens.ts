import type { FeedbackConversationDetailDtoOutput } from "../../api/generated/model/feedbackConversationDetailDtoOutput";
import {
  conversationBadges,
  type ConversationStatusFields,
} from "./conversationView";
import { outboxStatusBadge, type OutboxQueueState } from "./outboxQueue";

const AT = "2026-08-04T18:00:00Z";
const NEXT = "2026-08-04T18:00:45Z";
const PARKED_UNTIL = "2026-08-04T18:05:00Z";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "33333333-3333-4333-8333-333333333333";
const REASON_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

/**
 * Static specimens for the in-app mechanism map. Pure data — zero React — so
 * the page can mount the same inbox components operators already know.
 */
export function specimenConversationBadges() {
  const row: ConversationStatusFields = {
    goals: [{ status: "asked" }, { status: "pending" }],
    lifecycle: { state: "open", reason: null },
    control: { mode: "bot" },
    needsAttention: true,
  };
  return conversationBadges(row);
}

export function specimenOutboxBadges() {
  const states: OutboxQueueState[] = [
    "pending",
    "claimed",
    "attempting",
    "ambiguous",
  ];
  return states.map((status) => ({
    ...outboxStatusBadge(status),
    key: `outbox-${status}`,
  }));
}

function baseConversation(): FeedbackConversationDetailDtoOutput {
  return {
    id: CONVERSATION_ID,
    campaignId: CAMPAIGN_ID,
    respondentParticipantId: PARTICIPANT_ID,
    respondentDisplayName: "Ρούλα Ν.",
    phoneAtLaunch: "+306900000000",
    createdAt: AT,
    updatedAt: AT,
    remindedAt: null,
    needsAttention: true,
    awaitingHuman: false,
    staffClose: null,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: AT },
    capabilities: {
      canTakeOver: true,
      canResumeBot: false,
      canClose: true,
      canSendStaffMessage: false,
    },
    goals: [],
    messages: [],
    attentionReasons: [],
    extraction: {
      unreadParticipantMessages: 0,
      lastRunAt: null,
      model: null,
    },
    automation: {
      state: "idle",
      revision: 1,
      nextActionAt: null,
      claimExpiresAt: null,
    },
  };
}

/** Attention strip with one unresolved safety reason. */
export function specimenAttentionConversation(): FeedbackConversationDetailDtoOutput {
  const base = baseConversation();
  return {
    ...base,
    messages: [
      {
        id: MESSAGE_ID,
        seq: 1,
        actor: "participant",
        text: "Δεν θέλω να συνεχίσω έτσι.",
        at: AT,
        delivery: null,
        attention: null,
        ingressId: null,
        outboxId: null,
        providerMessageId: null,
      },
    ],
    attentionReasons: [
      {
        id: REASON_ID,
        kind: "safety",
        at: AT,
        messageId: MESSAGE_ID,
        resolvedAt: null,
        resolvedBy: null,
      },
    ],
  };
}

/** ΑΝΑΓΝΩΣΗ while two participant messages wait behind the quiet window. */
export function specimenReadingConversation(): FeedbackConversationDetailDtoOutput {
  const base = baseConversation();
  return {
    ...base,
    needsAttention: false,
    attentionReasons: [],
    extraction: {
      unreadParticipantMessages: 2,
      lastRunAt: AT,
      model: "openai/gpt-5",
    },
    automation: {
      state: "scheduled",
      revision: 4,
      nextActionAt: NEXT,
      claimExpiresAt: null,
    },
  };
}

/** Parked reading — the tinted danger ΑΝΑΓΝΩΣΗ case. */
export function specimenParkedReadingConversation(): FeedbackConversationDetailDtoOutput {
  const base = specimenReadingConversation();
  return {
    ...base,
    automation: {
      state: "parked",
      revision: 5,
      nextActionAt: PARKED_UNTIL,
      claimExpiresAt: null,
    },
  };
}

/** Actions row: Take over + Close available. */
export function specimenActionsConversation(): FeedbackConversationDetailDtoOutput {
  return {
    ...baseConversation(),
    needsAttention: false,
    attentionReasons: [],
  };
}
