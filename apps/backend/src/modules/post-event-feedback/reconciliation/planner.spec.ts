import { describe, expect, it } from "vitest";

import {
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
} from "../post-event-feedback-conversation.document.js";
import {
  FEEDBACK_PAUSED_CAMPAIGN_RECOMMENDATION,
  deriveFeedbackConversationReconciliationPlan,
  type FeedbackConversationReconciliationPolicy,
  type FeedbackReconciliationCampaignStatus,
} from "./planner.js";

const conversationId = "85b4e284-28d9-55e5-9d8b-e981671d37d2";
const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const policy: FeedbackConversationReconciliationPolicy = {
  quietWindowMs: 45_000,
  reminderIntervalMs: 24 * 3_600_000,
  expireAfterMs: 72 * 3_600_000,
  maxReminders: 2,
  parkRetryMs: 5 * 60_000,
  parkMaxMs: 6 * 3_600_000,
};

describe("deriveFeedbackConversationReconciliationPlan", () => {
  it.each<{
    name: string;
    conversation: FeedbackConversationDocument;
    campaignStatus: FeedbackReconciliationCampaignStatus | null;
    expected: object;
  }>([
    {
      name: "closed conversation",
      conversation: conversation({
        lifecycle: {
          state: "closed",
          reason: "completed",
          closedAt: createdAt,
        },
      }),
      campaignStatus: "launched",
      expected: { kind: "idle", reason: "conversation_closed" },
    },
    {
      name: "human control",
      conversation: conversation({
        control: {
          mode: "human",
          source: "staff_action",
          changedAt: createdAt,
        },
      }),
      campaignStatus: "launched",
      expected: { kind: "idle", reason: "human_control" },
    },
    {
      name: "awaiting human",
      conversation: conversation({ awaitingHuman: true }),
      campaignStatus: "launched",
      expected: { kind: "idle", reason: "awaiting_human" },
    },
    {
      name: "missing campaign",
      conversation: conversation(),
      campaignStatus: null,
      expected: { kind: "idle", reason: "campaign_missing" },
    },
    {
      name: "closed campaign",
      conversation: conversation(),
      campaignStatus: "closed",
      expected: { kind: "idle", reason: "campaign_closed" },
    },
    {
      name: "paused campaign",
      conversation: conversation({
        messages: [participantMessage(1, createdAt)],
      }),
      campaignStatus: "paused",
      expected: {
        kind: "idle",
        reason: "campaign_paused",
        recommendation: FEEDBACK_PAUSED_CAMPAIGN_RECOMMENDATION,
      },
    },
  ])("returns no automation for $name", (row) => {
    expect(
      plan({
        conversation: row.conversation,
        campaignStatus: row.campaignStatus,
        now: new Date(createdAt.getTime() + policy.expireAfterMs + 1),
      }),
    ).toEqual(row.expected);
  });

  it("uses a rolling quiet window for a slow typist", () => {
    const first = createdAt;
    const second = plusMs(first, 25_000);
    const third = plusMs(first, 50_000);
    const thread = conversation({
      messages: [
        participantMessage(1, first),
        participantMessage(2, second),
        participantMessage(3, third),
      ],
      updatedAt: third,
    });

    // The first fragment has been quiet for more than 45 seconds, but the
    // participant has not. Settling against the latest fragment is what avoids
    // buying one call per sentence from a slow typist.
    expect(plan({ conversation: thread, now: plusMs(first, 70_000) })).toEqual({
      kind: "wait",
      reason: "quiet_window",
      until: plusMs(third, policy.quietWindowMs),
    });
    expect(
      plan({
        conversation: thread,
        now: plusMs(third, policy.quietWindowMs),
      }),
    ).toEqual({
      kind: "extract",
      reason: "unread_testimony",
      snapshotSeq: 3,
    });
  });

  it("never calls the model after consent withdrawal but still schedules silent expiry", () => {
    const messageAt = plusMs(createdAt, 10_000);
    const thread = conversation({
      messages: [participantMessage(1, messageAt)],
      updatedAt: messageAt,
    });
    const expiryAt = plusMs(messageAt, policy.expireAfterMs);

    expect(
      plan({
        conversation: thread,
        consentGranted: false,
        now: plusMs(messageAt, policy.quietWindowMs),
      }),
    ).toEqual({ kind: "wait", reason: "expiry", until: expiryAt });
    expect(
      plan({
        conversation: thread,
        consentGranted: false,
        now: expiryAt,
      }),
    ).toEqual({
      kind: "expire",
      reason: "participant_silent",
      silentSince: messageAt,
    });
  });

  it("retries a parked provider incident only on its durable schedule", () => {
    const now = plusMs(createdAt, 20 * 60_000);
    const dueAt = plusMs(now, policy.parkRetryMs);
    const thread = conversation({
      messages: [participantMessage(1, createdAt)],
      extraction: {
        ...baseExtraction,
        parkedSince: plusMs(now, -10 * 60_000),
        parkedRuns: 2,
      },
      work: { revision: 4, nextActionAt: dueAt, executionEpoch: 3 },
      updatedAt: now,
    });

    expect(plan({ conversation: thread, now })).toEqual({
      kind: "wait",
      reason: "park_retry",
      until: dueAt,
    });
    expect(plan({ conversation: thread, now: dueAt })).toEqual({
      kind: "retry_parked",
      reason: "provider_incident",
      snapshotSeq: 1,
      parkedRun: 3,
    });
  });

  it("does not immediately retry a park whose bridge work still points at the failed run", () => {
    const parkedAt = plusMs(createdAt, 20 * 60_000);
    const thread = conversation({
      messages: [participantMessage(1, createdAt)],
      extraction: {
        ...baseExtraction,
        parkedSince: parkedAt,
        parkedRuns: 1,
      },
      // The extraction's own due timestamp is already in the past. The park
      // write updated the aggregate at `parkedAt`; that is the safe bridge
      // anchor until this plan settles the real retry schedule.
      work: { revision: 1, nextActionAt: createdAt, executionEpoch: 1 },
      updatedAt: parkedAt,
    });

    expect(plan({ conversation: thread, now: parkedAt })).toEqual({
      kind: "wait",
      reason: "park_retry",
      until: plusMs(parkedAt, policy.parkRetryMs),
    });
  });

  it("does not restart an exhausted park and keeps silent expiry armed", () => {
    const now = plusMs(createdAt, 7 * 3_600_000);
    const thread = conversation({
      messages: [participantMessage(1, createdAt)],
      extraction: {
        ...baseExtraction,
        parkedSince: createdAt,
        parkedRuns: 72,
      },
      work: { revision: 73, nextActionAt: now, executionEpoch: 72 },
      updatedAt: now,
    });

    expect(plan({ conversation: thread, now })).toEqual({
      kind: "wait",
      reason: "expiry",
      until: plusMs(createdAt, policy.expireAfterMs),
    });
  });

  it.each([
    {
      name: "first reminder",
      now: plusMs(createdAt, policy.reminderIntervalMs),
      overrides: {},
      expected: {
        kind: "remind",
        reason: "participant_silent",
        ordinal: 1,
      },
    },
    {
      name: "second reminder",
      now: plusMs(createdAt, 2 * policy.reminderIntervalMs),
      overrides: { reminderCount: 1 },
      expected: {
        kind: "remind",
        reason: "participant_silent",
        ordinal: 2,
      },
    },
    {
      name: "attention suppresses reminders",
      now: plusMs(createdAt, policy.reminderIntervalMs),
      overrides: { needsAttention: true },
      expected: {
        kind: "wait",
        reason: "expiry",
        until: plusMs(createdAt, policy.expireAfterMs),
      },
    },
    {
      name: "expiry outranks any remaining reminder",
      now: plusMs(createdAt, policy.expireAfterMs),
      overrides: {},
      expected: {
        kind: "expire",
        reason: "participant_silent",
        silentSince: createdAt,
      },
    },
  ])("plans one transition for $name", ({ now, overrides, expected }) => {
    expect(plan({ conversation: conversation(overrides), now })).toEqual(
      expected,
    );
  });
});

function plan(input: {
  readonly conversation: FeedbackConversationDocument;
  readonly now: Date;
  readonly campaignStatus?: FeedbackReconciliationCampaignStatus | null;
  readonly consentGranted?: boolean;
}) {
  return deriveFeedbackConversationReconciliationPlan({
    conversation: input.conversation,
    campaignStatus:
      input.campaignStatus === undefined ? "launched" : input.campaignStatus,
    consentGranted: input.consentGranted ?? true,
    now: input.now,
    policy,
  });
}

const baseExtraction: FeedbackConversationDocument["extraction"] = {
  cursorSeq: 0,
  lastRunAt: null,
  model: null,
  usage: null,
  serviceTier: null,
  parkedSince: null,
  parkedRuns: 0,
  parkedNoticeSentAt: null,
};

function conversation(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  const messages = overrides.messages ?? [];
  const lastMessageAt = messages.reduce(
    (latest, message) => (message.at > latest ? message.at : latest),
    createdAt,
  );
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
    goals: buildFeedbackConversationGoals(),
    messages,
    extraction: baseExtraction,
    work: { revision: 0, nextActionAt: null, executionEpoch: 0 },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    staffClose: null,
    createdAt,
    updatedAt: lastMessageAt,
    ...overrides,
  };
}

function participantMessage(
  seq: number,
  at: Date,
): FeedbackConversationMessage {
  const suffix = seq.toString().padStart(12, "0");
  return {
    id: `11111111-1111-4111-8111-${suffix}`,
    seq,
    actor: "participant",
    text: `participant ${seq}`,
    providerMessageId: null,
    ingressId: `22222222-2222-4222-8222-${suffix}`,
    outboxId: null,
    attention: null,
    at,
  };
}

function plusMs(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}
