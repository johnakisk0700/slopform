import { describe, expect, it } from "vitest";

import { createFeedbackClosingDedupeKey } from "../extraction/extraction.schemas.js";
import { createFeedbackStopAckDedupeKey } from "../question-set.js";
import { evaluateConversationDispatch } from "./dispatch-eligibility.js";

const conversationId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const outboxId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const otherOutboxId = "22b43614-8de9-48bd-a3e1-290427cfbbca";

describe("evaluateConversationDispatch", () => {
  it("continues an ordinary launched bot row", () => {
    expect(
      evaluateConversationDispatch({
        claim: replyClaim(),
        campaign: { status: "launched" },
        conversation: conversation(),
      }),
    ).toEqual({
      state: "continue",
      permittedStopAcknowledgement: false,
      permittedTerminalMessage: false,
    });
  });

  it("fails a route change before campaign or control gates", () => {
    expect(
      evaluateConversationDispatch({
        claim: replyClaim(),
        campaign: { status: "paused" },
        conversation: conversation({
          phoneAtLaunch: "+306900000099",
          control: "human",
        }),
        lockedPhoneAtLaunch: "+306900000001",
      }),
    ).toEqual({
      state: "settle",
      action: "finish_failed",
      reason: "conversation_route_changed",
    });
  });

  it("holds canonical terminal copy on an open conversation before pause", () => {
    expect(
      evaluateConversationDispatch({
        claim: closingClaim(),
        campaign: { status: "paused" },
        conversation: conversation(),
      }),
    ).toEqual({
      state: "settle",
      action: "release",
      reason: "terminal_transition_pending",
    });
  });

  it("lets the exact STOP acknowledgement continue through pause and close", () => {
    const claim = stopAckClaim();
    const stopped = conversation({
      state: "closed",
      reason: "stopped",
      terminalOutboxId: outboxId,
      control: "human",
    });

    expect(
      evaluateConversationDispatch({
        claim,
        campaign: { status: "paused" },
        conversation: stopped,
      }),
    ).toEqual({
      state: "continue",
      permittedStopAcknowledgement: true,
      permittedTerminalMessage: true,
    });
    expect(
      evaluateConversationDispatch({
        claim,
        campaign: { status: "closed" },
        conversation: stopped,
      }),
    ).toEqual({
      state: "continue",
      permittedStopAcknowledgement: true,
      permittedTerminalMessage: true,
    });
  });

  it("does not treat a STOP-shaped impostor as terminal authority", () => {
    expect(
      evaluateConversationDispatch({
        claim: stopAckClaim(),
        campaign: { status: "paused" },
        conversation: conversation({
          state: "closed",
          reason: "stopped",
          terminalOutboxId: otherOutboxId,
        }),
      }),
    ).toEqual({
      state: "settle",
      action: "release",
      reason: "campaign_paused",
    });
  });

  it("closes a campaign before human control or conversation closure", () => {
    expect(
      evaluateConversationDispatch({
        claim: replyClaim(),
        campaign: { status: "closed" },
        conversation: conversation({
          state: "closed",
          reason: "expired",
          control: "human",
        }),
      }),
    ).toEqual({
      state: "settle",
      action: "finish_cancelled",
      reason: "campaign_closed",
    });
  });

  it("pauses before human control", () => {
    expect(
      evaluateConversationDispatch({
        claim: replyClaim(),
        campaign: { status: "paused" },
        conversation: conversation({ control: "human" }),
      }),
    ).toEqual({
      state: "settle",
      action: "release",
      reason: "campaign_paused",
    });
  });

  it("cancels a non-terminal row on a closed conversation", () => {
    expect(
      evaluateConversationDispatch({
        claim: replyClaim(),
        campaign: { status: "launched" },
        conversation: conversation({
          state: "closed",
          reason: "expired",
        }),
      }),
    ).toEqual({
      state: "settle",
      action: "finish_cancelled",
      reason: "conversation_closed:expired",
    });
  });

  it("cancels bot copy under human control and keeps a staff row", () => {
    const human = conversation({ control: "human" });
    expect(
      evaluateConversationDispatch({
        claim: replyClaim(),
        campaign: { status: "launched" },
        conversation: human,
      }),
    ).toEqual({
      state: "settle",
      action: "finish_cancelled",
      reason: "human_control",
    });
    expect(
      evaluateConversationDispatch({
        claim: { ...replyClaim(), kind: "staff" },
        campaign: { status: "launched" },
        conversation: human,
      }),
    ).toEqual({
      state: "continue",
      permittedStopAcknowledgement: false,
      permittedTerminalMessage: false,
    });
  });

  it("continues only the conversation's winning closing row", () => {
    const completed = conversation({
      state: "closed",
      reason: "completed",
      terminalOutboxId: outboxId,
    });
    expect(
      evaluateConversationDispatch({
        claim: closingClaim(),
        campaign: { status: "launched" },
        conversation: completed,
      }),
    ).toEqual({
      state: "continue",
      permittedStopAcknowledgement: false,
      permittedTerminalMessage: true,
    });
    expect(
      evaluateConversationDispatch({
        claim: closingClaim(),
        campaign: { status: "launched" },
        conversation: {
          ...completed,
          lifecycle: {
            ...completed.lifecycle,
            terminalOutboxId: otherOutboxId,
          },
        },
      }),
    ).toEqual({
      state: "settle",
      action: "finish_cancelled",
      reason: "conversation_closed:completed",
    });
  });
});

function replyClaim() {
  return {
    id: outboxId,
    conversationId,
    kind: "reply" as const,
    dedupeKey: `feedback-reply-${conversationId}-3`,
  };
}

function closingClaim() {
  return {
    id: outboxId,
    conversationId,
    kind: "reply" as const,
    dedupeKey: createFeedbackClosingDedupeKey(conversationId, 3, 7),
  };
}

function stopAckClaim() {
  return {
    id: outboxId,
    conversationId,
    kind: "system" as const,
    dedupeKey: createFeedbackStopAckDedupeKey(conversationId),
  };
}

function conversation(
  overrides: {
    readonly phoneAtLaunch?: string;
    readonly state?: "open" | "closed";
    readonly reason?: "completed" | "declined" | "stopped" | "expired";
    readonly terminalOutboxId?: string;
    readonly control?: "bot" | "human";
  } = {},
) {
  const state = overrides.state ?? "open";
  return {
    phoneAtLaunch: overrides.phoneAtLaunch ?? "+306900000001",
    lifecycle:
      state === "closed"
        ? {
            state: "closed" as const,
            reason: overrides.reason ?? "completed",
            closedAt: new Date("2026-07-25T00:00:00.000Z"),
            ...(overrides.terminalOutboxId === undefined
              ? {}
              : { terminalOutboxId: overrides.terminalOutboxId }),
          }
        : {
            state: "open" as const,
            reason: null,
            closedAt: null,
          },
    control: {
      mode: overrides.control ?? "bot",
      source: "launch" as const,
      changedAt: new Date("2026-07-24T23:55:00.000Z"),
    },
  };
}
