import { describe, expect, it } from "vitest";

import type { FeedbackOutboxMessageDeliveryDtoOutputDispatch } from "../src/api/generated/model/feedbackOutboxMessageDeliveryDtoOutputDispatch";
import type { FeedbackOutboxMessageDeliveryDtoOutputLog } from "../src/api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLog";
import type { FeedbackOutboxMessageDeliveryDtoOutputLogConversationState } from "../src/api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLogConversationState";
import type { FeedbackOutboxQueueDtoOutput } from "../src/api/generated/model/feedbackOutboxQueueDtoOutput";
import type { FeedbackOutboxQueueDtoOutputItemsItem } from "../src/api/generated/model/feedbackOutboxQueueDtoOutputItemsItem";
import {
  describeWaiting,
  deliveryActivityLines,
  formatDelta,
  formatWaiting,
  isOutboxHistoryRangeKey,
  isOutboxHistoryStatus,
  OUTBOX_HISTORY_RANGES,
  OUTBOX_HISTORY_STATUS_FILTERS,
  OUTBOX_LOG_ABSENT_COPY,
  outboundConversationStateFacts,
  outboundDecisionFacts,
  outboundDeliveryTimeline,
  outboundModelProvider,
  outboundOriginLabel,
  outboxHistoryRangeFrom,
  outboxHistoryStatusBadge,
  outboxKindLabel,
  outboxProviderReadingBadge,
  outboxQueueSummary,
  outboxStatusBadge,
  outboxWaitingTone,
} from "../src/features/feedback/outboxQueue";
import {
  OUTBOX_HISTORY_POLL_INTERVAL_MS,
  OUTBOX_MESSAGE_POLL_INTERVAL_MS,
  OUTBOX_QUEUE_POLL_INTERVAL_MS,
} from "../src/features/feedback/polling";

const ID = "00000000-0000-0000-0000-000000000000";
const TIME = "2026-07-27T11:41:00.000Z";

function queueItem(
  overrides: Partial<FeedbackOutboxQueueDtoOutputItemsItem> = {},
): FeedbackOutboxQueueDtoOutputItemsItem {
  return {
    campaignId: ID,
    campaignStatus: "launched",
    conversationId: ID,
    createdAt: TIME,
    deliveryStatus: null,
    eventId: ID,
    eventTitle: "Dinner",
    id: ID,
    kind: "reply",
    phoneAtLaunch: "+306900000000",
    respondentDisplayName: "Κώστας",
    respondentParticipantId: ID,
    status: "pending",
    updatedAt: TIME,
    waitingSeconds: 3,
    ...overrides,
  };
}

function dispatch(
  overrides: Partial<FeedbackOutboxMessageDeliveryDtoOutputDispatch> = {},
): FeedbackOutboxMessageDeliveryDtoOutputDispatch {
  return {
    attemptCount: 0,
    claimExpiresAt: null,
    lastError: null,
    sendStartedAt: null,
    state: "pending",
    ...overrides,
  };
}

type TimelineInput = Parameters<typeof outboundDeliveryTimeline>[0];

function timelineMessage(
  overrides: Partial<TimelineInput["message"]> = {},
): TimelineInput["message"] {
  return {
    createdAt: TIME,
    deliveredAt: null,
    playedAt: null,
    readAt: null,
    sentAt: null,
    status: "pending",
    updatedAt: TIME,
    ...overrides,
  };
}

function conversationState(
  overrides: Partial<FeedbackOutboxMessageDeliveryDtoOutputLogConversationState> = {},
): FeedbackOutboxMessageDeliveryDtoOutputLogConversationState {
  return {
    awaitingHuman: false,
    control: { mode: "bot", source: "launch" },
    extractionCursorSeq: 5,
    goals: [
      { key: "event_score", status: "answered" },
      { key: "liked", status: "asked" },
      { key: "meet_again", status: "pending" },
    ],
    latestMessageSeq: 6,
    lifecycle: { state: "open", reason: null },
    messageCount: 4,
    needsAttention: false,
    reminderCount: 0,
    unresolvedAttentionCount: 0,
    ...overrides,
  };
}

type DecisionLog = NonNullable<FeedbackOutboxMessageDeliveryDtoOutputLog>;

function log(overrides: Partial<DecisionLog> = {}): DecisionLog {
  return {
    conversationState: conversationState(),
    correlationId: "req-71c",
    createdAt: TIME,
    decision: {
      askedGoal: "liked",
      closingReason: null,
      confidence: 0.84,
      goalStatuses: [
        { key: "event_score", status: "answered" },
        { key: "liked", status: "asked" },
      ],
      model: "google/gemini-2.5-flash",
      origin: "extraction_reply",
    },
    origin: "extraction_reply",
    ...overrides,
  };
}

type Fact = ReturnType<typeof outboundDecisionFacts>[number];

function fact(facts: readonly Fact[], label: string): Fact | undefined {
  return facts.find((candidate) => candidate.label === label);
}

describe("queue age and status", () => {
  it("separates fresh, slow, stalled and deliberately parked work", () => {
    expect(outboxWaitingTone(queueItem({ waitingSeconds: 5 }))).toBe("fresh");
    expect(outboxWaitingTone(queueItem({ waitingSeconds: 30 }))).toBe("slow");
    expect(outboxWaitingTone(queueItem({ waitingSeconds: 60 }))).toBe(
      "stalled",
    );
    expect(
      outboxWaitingTone(
        queueItem({ campaignStatus: "paused", waitingSeconds: 3_600 }),
      ),
    ).toBe("parked");
    expect(outboxWaitingTone(queueItem({ status: "held" }))).toBe("parked");
  });

  it("formats compact ages and spoken screen-reader values", () => {
    expect(formatWaiting(8)).toBe("8s");
    expect(formatWaiting(147)).toBe("2m 27s");
    expect(formatWaiting(3_600)).toBe("1h 00m");
    expect(formatWaiting(-4)).toBe("0s");
    expect(describeWaiting(1)).toBe("1 second");
    expect(describeWaiting(120)).toBe("2 minutes");
    expect(describeWaiting(147)).toBe("2 minutes 27 seconds");
  });

  it("uses one status vocabulary for queue rows and history", () => {
    expect(outboxStatusBadge("pending")).toMatchObject({ label: "Queued" });
    expect(outboxStatusBadge("ambiguous")).toMatchObject({
      label: "Reconciliation required",
      tone: "danger",
    });
    expect(outboxStatusBadge("held")).toMatchObject({
      label: "Held",
      tone: "warning",
    });
    expect(outboxHistoryStatusBadge("sent")).toMatchObject({
      label: "Sent",
      tone: "success",
    });
    expect(outboxHistoryStatusBadge("failed")).toMatchObject({
      label: "Failed",
      tone: "danger",
    });
    expect(outboxKindLabel("staff")).toBe("Staff message");
  });

  it("summarizes the total and oldest visible queue item", () => {
    const view: FeedbackOutboxQueueDtoOutput = {
      counts: {
        ambiguous: 0,
        attempting: 0,
        claimed: 0,
        held: 4,
        pending: 300,
        sending: 2,
        total: 306,
      },
      items: [
        queueItem({ waitingSeconds: 147 }),
        queueItem({ waitingSeconds: 4 }),
      ],
      observedAt: TIME,
      truncated: true,
    };
    expect(outboxQueueSummary(view)).toEqual({
      total: 306,
      held: 4,
      oldestWaitingSeconds: 147,
      worstTone: "stalled",
    });
    expect(
      outboxQueueSummary({
        ...view,
        counts: { ...view.counts, total: 0 },
        items: [],
      }).oldestWaitingSeconds,
    ).toBeNull();
  });
});

describe("durable dispatch activity", () => {
  it("distinguishes a safe claim from an irreversible provider attempt", () => {
    const claimed = deliveryActivityLines(
      dispatch({
        state: "claimed",
        claimExpiresAt: "2026-07-27T11:47:00.000Z",
      }),
      new Date("2026-07-27T11:41:00.000Z"),
    );
    expect(claimed).toMatchObject({ state: "Claimed", tone: "none" });
    expect(claimed.timing).toContain("may then be reclaimed");

    const attempting = deliveryActivityLines(
      dispatch({ state: "attempting", attemptCount: 1, sendStartedAt: TIME }),
    );
    expect(attempting.explanation).toContain(
      "not automatically reclaimed or resent",
    );
    expect(attempting.attempt).toContain("recorded durably");
  });

  it("makes an ambiguous outcome and its recorded reason visible", () => {
    const lines = deliveryActivityLines(
      dispatch({
        state: "ambiguous",
        attemptCount: 1,
        lastError: "transport_timeout",
        sendStartedAt: TIME,
      }),
    );
    expect(lines).toMatchObject({
      state: "Needs reconciliation",
      tone: "danger",
    });
    expect(lines.explanation).toContain("Automatic resend is blocked");
    expect(lines.recordedReason).toBe("Recorded reason: transport_timeout");
  });

  it("describes legacy states without pretending there is a retry", () => {
    expect(
      deliveryActivityLines(dispatch({ state: "sending" })).attempt,
    ).toContain("pre-cutover");
    expect(
      deliveryActivityLines(dispatch({ state: "sent" })).attempt,
    ).toContain("pre-cutover");
    expect(
      deliveryActivityLines(dispatch({ state: "failed", attemptCount: 1 }))
        .tone,
    ).toBe("danger");
  });
});

describe("decision and conversation facts", () => {
  it("keeps model confidence, question names and correlation ids truthful", () => {
    const facts = outboundDecisionFacts(
      log(),
      new Date("2026-07-27T11:42:00.000Z"),
    );
    expect(fact(facts, "Origin")?.value).toBe("Model reply");
    expect(fact(facts, "Model")?.value).toBe("google/gemini-2.5-flash");
    expect(fact(facts, "Confidence")?.value).toBe("84%");
    expect(fact(facts, "Confidence")?.kind).toBe("confidence");
    expect(fact(facts, "Asked")?.value).toBe("Liked (V1)");
    expect(fact(facts, "Correlation id")?.value).toBe("req-71c");
  });

  it("does not invent confidence or hide an explicit closing reason", () => {
    const facts = outboundDecisionFacts(
      log({
        decision: {
          askedGoal: null,
          closingReason: "completed",
          confidence: null,
          goalStatuses: [],
          model: "google/gemini-2.5-flash",
          origin: "extraction_reply",
        },
      }),
    );
    expect(fact(facts, "Confidence")).toMatchObject({
      value: "not reported",
      ratio: null,
    });
    expect(fact(facts, "Closed the thread")?.value).toBe("Completed");
    expect(fact(facts, "Goals it recorded")?.value).toBe("none");
  });

  it("keeps free-text failure causes and origin labels readable", () => {
    expect(outboundOriginLabel("staff_message")).toBe("Staff message");
    expect(
      outboundDecisionFacts(
        log({
          origin: "extraction_fallback_ack",
          decision: {
            cause: "quota_exhausted",
            origin: "extraction_fallback_ack",
          },
        }),
      ).find(({ label }) => label === "Cause")?.value,
    ).toBe("quota_exhausted");
    expect(outboundModelProvider("openai/gpt-4.1")).toBe("openai");
    expect(outboundModelProvider("google/gemini")).toBe("generic");
  });

  it("reports the conversation snapshot used by the writer", () => {
    const facts = outboundConversationStateFacts(
      conversationState({
        awaitingHuman: true,
        control: { mode: "human", source: "staff_action" },
        lifecycle: { state: "closed", reason: "stopped" },
        needsAttention: true,
        unresolvedAttentionCount: 2,
      }),
    );
    expect(fact(facts, "Lifecycle")?.value).toBe("Stopped");
    expect(fact(facts, "Control")?.value).toBe(
      "Human control after a staff action",
    );
    expect(fact(facts, "Attention")?.value).toBe(
      "Flagged (2 unresolved) · waiting on a person",
    );
    expect(fact(facts, "Messages")?.value).toBe("4, latest #6");
  });

  it("states when a row predates the decision log", () => {
    expect(OUTBOX_LOG_ABSENT_COPY).toContain("before the decision log existed");
  });
});

describe("delivery timeline", () => {
  it("renders happened steps in time order with gaps between them", () => {
    const timeline = outboundDeliveryTimeline({
      message: timelineMessage({
        deliveredAt: "2026-07-27T11:41:01.600Z",
        readAt: "2026-07-27T11:43:10.600Z",
        sentAt: "2026-07-27T11:41:00.400Z",
        status: "sent",
        updatedAt: "2026-07-27T11:41:00.400Z",
      }),
      dispatch: dispatch({ state: "sent" }),
    });
    expect(timeline.map(({ label }) => label)).toStrictEqual([
      "Written",
      "Sent",
      "Delivered",
      "Read",
    ]);
    expect(timeline[1]?.sincePrevious).toBe("+400ms");
    expect(timeline[2]?.sincePrevious).toBe("+1.2s");
    expect(timeline[3]?.sincePrevious).toBe("+2m 09s");
  });

  it("adds the provider boundary and terminal state without inventing absent steps", () => {
    const timeline = outboundDeliveryTimeline({
      message: timelineMessage({
        status: "ambiguous",
        updatedAt: "2026-07-27T11:41:09.000Z",
      }),
      dispatch: dispatch({
        sendStartedAt: "2026-07-27T11:41:02.000Z",
        state: "ambiguous",
      }),
    });
    expect(timeline.map(({ label }) => label)).toStrictEqual([
      "Written",
      "Provider attempt started",
      "Needs reconciliation",
    ]);
    expect(timeline.at(-1)?.terminal).toBe(true);
  });

  it("keeps sub-second gaps and provider readings that have no timeline timestamp", () => {
    expect(formatDelta(412)).toBe("+412ms");
    expect(formatDelta(1_400)).toBe("+1.4s");
    expect(formatDelta(-50)).toBe("+0ms");
    for (const status of ["sent", "delivered", "read", "played"] as const) {
      expect(outboxProviderReadingBadge(status)).toBeNull();
    }
    expect(outboxProviderReadingBadge("error")).toEqual(
      expect.objectContaining({ tone: "danger" }),
    );
    expect(outboxProviderReadingBadge("pending")?.label).toContain(
      "not confirmed",
    );
  });
});

describe("history filters and refresh", () => {
  it("uses operator-friendly range presets and rejects URL inventions", () => {
    expect(OUTBOX_HISTORY_RANGES.map(({ key }) => key)).toStrictEqual([
      "hour",
      "today",
      "week",
      "all",
    ]);
    const now = new Date("2026-07-27T11:43:27.000Z");
    expect(outboxHistoryRangeFrom("hour", now)).toBe(
      "2026-07-27T10:43:27.000Z",
    );
    expect(outboxHistoryRangeFrom("week", now)).toBe(
      "2026-07-20T11:43:27.000Z",
    );
    expect(outboxHistoryRangeFrom("all", now)).toBeUndefined();
    expect(isOutboxHistoryRangeKey("today")).toBe(true);
    expect(isOutboxHistoryRangeKey("fortnight")).toBe(false);
    expect(isOutboxHistoryRangeKey(null)).toBe(false);
  });

  it("builds status filters from the same labels history rows use", () => {
    expect(OUTBOX_HISTORY_STATUS_FILTERS[0]?.key).toBe("any");
    for (const option of OUTBOX_HISTORY_STATUS_FILTERS) {
      if (option.key !== "any") {
        expect(option.label).toBe(outboxHistoryStatusBadge(option.key).label);
      }
    }
    expect(isOutboxHistoryStatus("failed")).toBe(true);
    expect(isOutboxHistoryStatus("exploded")).toBe(false);
  });

  it("keeps queue and opened-message polling faster than history", () => {
    expect(OUTBOX_QUEUE_POLL_INTERVAL_MS).toBe(3_000);
    expect(OUTBOX_MESSAGE_POLL_INTERVAL_MS).toBe(3_000);
    expect(OUTBOX_HISTORY_POLL_INTERVAL_MS).toBe(5_000);
  });
});
