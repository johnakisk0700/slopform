import { describe, expect, it } from "vitest";

import type {
  MessageOutboxRow,
  ProviderMessageIngressRow,
} from "@slopform/database";

import { createFeedbackClosingDedupeKey } from "../extraction/extraction.schemas.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { toRunView } from "./run-status.js";

describe("feedback simulator run status", () => {
  it("terminates an unknown simulated provider outcome as an explicit failed run", () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const outboxId = "22222222-2222-4222-8222-222222222222";
    const view = toRunView({
      run: {
        id: "33333333-3333-4333-8333-333333333333",
        correlationId: "fault-rehearsal-1",
        campaignId: "44444444-4444-4444-8444-444444444444",
        conversationId,
        scenarioId: "greeklish",
        scenarioTitle: "Greeklish",
        expectedModel: "openai/gpt-5.6-terra",
        configuredModel: "openai/gpt-5.6-terra",
        startedAt: new Date("2026-08-04T10:00:00.000Z"),
        baselineOutboxCount: 0,
        totalMessages: 1,
        targetCursorSeq: 1,
        candidateBindings: [],
        renderedMessages: ["Ήταν ωραία."],
        rubric: { rationale: ["fault-path"] },
        ingressIds: ["55555555-5555-4555-8555-555555555555"],
        injectionError: null,
      },
      conversation: {
        extraction: {
          cursorSeq: 1,
          model: "openai/gpt-5.6-terra",
        },
        lifecycle: { state: "closed", reason: "completed" },
        control: { mode: "bot" },
        work: { revision: 7, nextActionAt: null, executionEpoch: 3 },
      } as unknown as FeedbackConversationDocument,
      ingressRows: [
        { processingStatus: "materialized" } as ProviderMessageIngressRow,
      ],
      answers: [],
      notes: [],
      outbox: [
        {
          id: outboxId,
          dedupeKey: createFeedbackClosingDedupeKey(conversationId, 1, 7),
          status: "ambiguous",
        } as MessageOutboxRow,
      ],
      simulatedSends: [],
      automation: {
        active: false,
        pending: false,
        failedReason: null,
        nextExtractionAt: null,
      },
    });

    expect(view.stage).toBe("failed");
    expect(view.error).toMatch(/unknown outcome.*ambiguous/iu);
  });
});
