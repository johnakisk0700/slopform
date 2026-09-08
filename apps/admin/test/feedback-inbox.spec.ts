import { describe, expect, it } from "vitest";

import type { FeedbackCampaignConversationsDtoOutputConversationsItem } from "../src/api/generated/model/feedbackCampaignConversationsDtoOutputConversationsItem";
import {
  canCorrectAnswerValue,
  canWithdrawAnswer,
  correctionSummary,
  FEEDBACK_SCORE_CHOICES,
  withdrawalDescription,
} from "../src/features/feedback/answerCorrections";
import {
  campaignSummaryActionLabel,
  campaignSummaryElapsedLabel,
  campaignSummaryPartialWarning,
  campaignSummaryPendingDetail,
  campaignSummaryPendingPhase,
  campaignSummaryStatusLabel,
} from "../src/features/feedback/campaignSummary";
import {
  conversationReplyIndicator,
  goalProgress,
  resolveSelectedConversationId,
  sortConversationsForInbox,
} from "../src/features/feedback/conversationView";
import {
  answerCandidateChoices,
  contradictedQuestionKeys,
  DIRECTED_QUESTION_KEYS,
  directedQuestionTone,
  isDirectedQuestion,
  recordAnswerDescription,
} from "../src/features/feedback/directedAnswers";
import { readingStatusLines } from "../src/features/feedback/extractionStatus";
import {
  awaitingDeliveryReason,
  deliveryBadge,
  isAwaitingDelivery,
} from "../src/features/feedback/labels";
import {
  CAMPAIGN_SUMMARY_POLL_INTERVAL_MS,
  CONVERSATION_LIST_POLL_INTERVAL_MS,
  CONVERSATION_POLL_INTERVAL_MS,
  conversationPollInterval,
  RESULTS_POLL_INTERVAL_MS,
} from "../src/features/feedback/polling";
import {
  createStaffMessageDraft,
  editStaffMessageDraft,
  settleStaffMessageDraft,
} from "../src/features/feedback/staffMessageDraft";

const ID = "00000000-0000-0000-0000-000000000000";
const BASE_TIME = "2026-07-20T10:00:00.000Z";

function conversation(
  overrides: Partial<FeedbackCampaignConversationsDtoOutputConversationsItem> = {},
): FeedbackCampaignConversationsDtoOutputConversationsItem {
  return {
    campaignId: ID,
    capabilities: {
      canClose: true,
      canResumeBot: true,
      canSendStaffMessage: true,
      canTakeOver: true,
    },
    control: { mode: "bot", source: "launch" },
    createdAt: BASE_TIME,
    goals: [],
    id: ID,
    lastMessageActor: null,
    lastMessageAt: BASE_TIME,
    lifecycle: { state: "open", reason: null },
    messageCount: 0,
    needsAttention: false,
    phoneAtLaunch: "+306900000000",
    remindedAt: null,
    respondentDisplayName: "Κώστας",
    respondentParticipantId: ID,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

type Delivery = NonNullable<Parameters<typeof deliveryBadge>[0]>;

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    deliveredAt: null,
    deliveryStatus: null,
    outboxId: ID,
    outboxStatus: "pending",
    playedAt: null,
    readAt: null,
    sentAt: null,
    ...overrides,
  };
}

type ReadingInput = Parameters<typeof readingStatusLines>[0];

function reading(overrides: Partial<ReadingInput> = {}): ReadingInput {
  return {
    unreadParticipantMessages: 0,
    lastRunAt: null,
    model: null,
    automation: {
      claimExpiresAt: null,
      nextActionAt: null,
      revision: 0,
      state: "idle",
    },
    constraint: "none",
    ...overrides,
  };
}

describe("participant and delivery labels", () => {
  it("lets provider status outrank an outbox state", () => {
    expect(deliveryBadge(delivery({ deliveryStatus: "read" }))).toEqual(
      expect.objectContaining({ label: "Read", tone: "success" }),
    );
    expect(deliveryBadge(delivery({ outboxStatus: "failed" }))).toEqual(
      expect.objectContaining({ label: "Delivery failed", tone: "danger" }),
    );
    expect(
      deliveryBadge(delivery({ outboxStatus: "sent" }))?.label,
    ).toBeUndefined();
  });

  it("marks queued and held messages as unseen until they settle", () => {
    for (const outboxStatus of ["pending", "sending", "held"] as const) {
      const item = delivery({ outboxStatus });
      expect(isAwaitingDelivery(item)).toBe(true);
      expect(awaitingDeliveryReason(item)).toContain(
        "not seen by the participant",
      );
    }
    expect(isAwaitingDelivery(delivery({ outboxStatus: "sent" }))).toBe(false);
    expect(awaitingDeliveryReason(null)).toBeNull();
  });
});

describe("conversation progress and grouping", () => {
  it("counts skipped goals as settled while leaving asked goals outstanding", () => {
    expect(
      goalProgress([
        { status: "answered" },
        { status: "skipped" },
        { status: "asked" },
        { status: "pending" },
      ]),
    ).toEqual({
      answered: 1,
      skipped: 1,
      outstanding: 2,
      settled: 2,
      total: 4,
    });
  });

  it("puts attention first, then recent activity, with a stable id tie-break", () => {
    const sorted = sortConversationsForInbox([
      conversation({ id: "z", lastMessageAt: "2026-07-20T12:00:00.000Z" }),
      conversation({
        id: "attention",
        needsAttention: true,
        lastMessageAt: "2026-07-20T09:00:00.000Z",
      }),
      conversation({ id: "a", lastMessageAt: "2026-07-20T12:00:00.000Z" }),
    ]);
    expect(sorted.map(({ id }) => id)).toStrictEqual(["attention", "a", "z"]);
  });
});

describe("conversation selection and transcript", () => {
  it("keeps an explicit selection, then a sticky selection, before falling back", () => {
    expect(
      resolveSelectedConversationId(
        [{ ...conversation({ id: "a" }) }, { ...conversation({ id: "b" }) }],
        "b",
        "a",
      ),
    ).toBe("b");
    expect(
      resolveSelectedConversationId(
        [{ ...conversation({ id: "b" }) }, { ...conversation({ id: "a" }) }],
        null,
        "a",
      ),
    ).toBe("a");
    expect(
      resolveSelectedConversationId(
        [{ ...conversation({ id: "b" }) }],
        null,
        "gone",
      ),
    ).toBe("b");
    expect(resolveSelectedConversationId([], "gone")).toBeNull();
  });
});

describe("automation status and polling", () => {
  it("reports durable automation constraints and model provenance", () => {
    expect(
      readingStatusLines(
        reading({
          unreadParticipantMessages: 2,
          model: "google/gemini",
          automation: {
            claimExpiresAt: null,
            nextActionAt: null,
            revision: 2,
            state: "idle",
          },
          constraint: "human_control",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        model: "Μοντέλο: google/gemini",
        attention: "pending",
        schedule: expect.stringContaining("άνθρωπος"),
      }),
    );
  });

  it("shows running, scheduled and parked states distinctly", () => {
    const now = new Date("2026-07-20T10:00:00.000Z");
    expect(
      readingStatusLines(
        reading({
          automation: {
            claimExpiresAt: "2026-07-20T10:02:00.000Z",
            nextActionAt: null,
            revision: 1,
            state: "running",
          },
        }),
        now,
      ).schedule,
    ).toContain("Ανάγνωση σε εξέλιξη");
    expect(
      readingStatusLines(
        reading({
          automation: {
            claimExpiresAt: null,
            nextActionAt: "2026-07-20T10:05:00.000Z",
            revision: 1,
            state: "scheduled",
          },
        }),
        now,
      ).schedule,
    ).toContain("Επόμενη");
    expect(
      readingStatusLines(
        reading({
          automation: {
            claimExpiresAt: null,
            nextActionAt: null,
            revision: 1,
            state: "parked",
          },
        }),
        now,
      ).attention,
    ).toBe("danger");
  });

  it("polls open conversations, stops closed ones, and uses slower list intervals", () => {
    expect(conversationPollInterval(undefined)).toBe(
      CONVERSATION_POLL_INTERVAL_MS,
    );
    expect(conversationPollInterval({ lifecycle: { state: "open" } })).toBe(
      2_000,
    );
    expect(conversationPollInterval({ lifecycle: { state: "closed" } })).toBe(
      false,
    );
    expect(CONVERSATION_POLL_INTERVAL_MS).toBeLessThan(
      CONVERSATION_LIST_POLL_INTERVAL_MS,
    );
    expect(RESULTS_POLL_INTERVAL_MS).toBeGreaterThan(
      CONVERSATION_LIST_POLL_INTERVAL_MS,
    );
    expect(CAMPAIGN_SUMMARY_POLL_INTERVAL_MS).toBe(3_000);
  });

  it("reports the next actor only for a live bot lease or explicit handoff", () => {
    expect(
      conversationReplyIndicator({
        lifecycle: { state: "open" },
        control: { mode: "bot" },
        automation: { state: "running" },
        awaitingHuman: false,
      }),
    ).toBe("bot_replying");
    expect(
      conversationReplyIndicator({
        lifecycle: { state: "open" },
        control: { mode: "bot" },
        automation: { state: "running" },
        awaitingHuman: true,
      }),
    ).toBe("awaiting_staff");
    expect(
      conversationReplyIndicator({
        lifecycle: { state: "closed" },
        control: { mode: "bot" },
        automation: { state: "running" },
        awaitingHuman: false,
      }),
    ).toBeNull();
  });
});

describe("operator answer and close actions", () => {
  it("offers score correction only for scored questions and withdrawal for directed answers", () => {
    expect(FEEDBACK_SCORE_CHOICES).toStrictEqual([1, 2, 3, 4, 5]);
    expect(
      canCorrectAnswerValue({
        questionKey: "event_score",
        valueInt: 3,
        subjectParticipantId: null,
        correction: null,
      }),
    ).toBe(true);
    expect(
      canCorrectAnswerValue({
        questionKey: "meet_again",
        valueInt: null,
        subjectParticipantId: ID,
        correction: null,
      }),
    ).toBe(false);
    expect(
      canWithdrawAnswer({
        questionKey: "meet_again",
        valueInt: null,
        subjectParticipantId: ID,
        correction: null,
      }),
    ).toBe(true);
  });

  it("shows who corrected a value and explains a withdrawal", () => {
    expect(
      correctionSummary({
        questionKey: "event_score",
        valueInt: 4,
        subjectParticipantId: null,
        correction: { at: "2026-07-20T10:00:00.000Z", by: "Ada" },
      }),
    ).toContain("Corrected by Ada");
    expect(
      correctionSummary({
        questionKey: "event_score",
        valueInt: 4,
        subjectParticipantId: null,
        correction: null,
      }),
    ).toBeNull();
    expect(withdrawalDescription("No rematch", "Μαρία")).toContain(
      "no message is sent",
    );
  });

  it("keeps incompatible directed answers visible before confirming a move", () => {
    expect(DIRECTED_QUESTION_KEYS).toStrictEqual([
      "liked",
      "meet_again",
      "avoid",
    ]);
    expect(isDirectedQuestion("avoid")).toBe(true);
    expect(isDirectedQuestion("event_score")).toBe(false);
    expect(contradictedQuestionKeys("avoid")).toStrictEqual([
      "liked",
      "meet_again",
    ]);
    expect(directedQuestionTone("avoid")).toBe("warning");

    expect(
      answerCandidateChoices(
        [
          { participantId: "p-maria", displayName: "Μαρία" },
          { participantId: "p-nikos", displayName: "Νίκος" },
        ],
        [
          { questionKey: "liked", subjectParticipantId: "p-maria" },
          { questionKey: "avoid", subjectParticipantId: "p-nikos" },
        ],
        "avoid",
      ),
    ).toEqual([
      expect.objectContaining({
        participantId: "p-maria",
        movesFrom: ["liked"],
      }),
    ]);
    expect(
      recordAnswerDescription({
        questionLabel: "Avoid",
        subjectLabel: "Μαρία",
        movesFromLabels: ["Liked"],
      }),
    ).toContain("withdrawn");
  });
});

describe("campaign summaries and drafts", () => {
  it("distinguishes queued, generating and retrying summary work", () => {
    const now = new Date("2026-07-20T10:00:00.000Z");
    const base = {
      status: "pending" as const,
      executionEpoch: 0,
      claimExpiresAt: null,
    };
    expect(campaignSummaryPendingPhase(base, now)).toBe("queued");
    expect(
      campaignSummaryPendingPhase(
        { ...base, claimExpiresAt: "2026-07-20T10:01:00.000Z" },
        now,
      ),
    ).toBe("generating");
    expect(
      campaignSummaryPendingPhase({ ...base, executionEpoch: 1 }, now),
    ).toBe("retrying");
    expect(campaignSummaryPendingDetail("retrying")).toContain("retry");
  });

  it("formats elapsed summary time and partial-data warnings", () => {
    const now = new Date("2026-07-20T10:02:00.000Z");
    expect(campaignSummaryElapsedLabel("2026-07-20T10:00:00.000Z", now)).toBe(
      "2 min",
    );
    expect(campaignSummaryElapsedLabel(null, now)).toBeNull();
    expect(
      campaignSummaryPartialWarning({
        isPartial: false,
        openConversationCount: 0,
      }),
    ).toBeNull();
    expect(
      campaignSummaryPartialWarning({
        isPartial: true,
        openConversationCount: 1,
      }),
    ).toContain("1 conversation");
    expect(
      campaignSummaryStatusLabel({
        status: "ready",
        isPartial: true,
        requestedAt: null,
        executionEpoch: null,
        claimExpiresAt: null,
      }),
    ).toBe("Partial");
    expect(campaignSummaryActionLabel("failed")).toBe("Generate");
  });

  it("keeps a failed or unknown staff send retryable and rotates only after success", () => {
    const empty = createStaffMessageDraft(() => "draft-1");
    const written = editStaffMessageDraft(empty, "Γεια σου", () => "draft-2");
    expect(
      settleStaffMessageDraft(written, "draft-2", false, () => "unused"),
    ).toBe(written);
    expect(
      settleStaffMessageDraft(written, "draft-1", true, () => "unused"),
    ).toBe(written);
    expect(
      settleStaffMessageDraft(written, "draft-2", true, () => "draft-3"),
    ).toEqual({ text: "", clientMessageId: "draft-3" });
  });
});
