import { ConflictException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { Environment } from "../../../infrastructure/config/environment.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackBurstController } from "./burst.controller.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("FeedbackBurstController accounting", () => {
  it("returns the API process's durable accounting projection", async () => {
    const rows = [
      {
        conversationId: "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55",
        extraction: {
          model: "openai/gpt-5.6-luna",
          usage: {
            inputTokens: 1_200,
            outputTokens: 200,
            totalTokens: 1_400,
          },
          serviceTier: null,
        },
      },
    ];
    const conversations = {
      listExtractionAccountingForCampaigns: vi.fn().mockResolvedValue(rows),
    };
    const controller = createController({ conversations });

    await expect(
      controller.getAccounting({ campaignId: [campaignId] }),
    ).resolves.toEqual(rows);
    expect(
      conversations.listExtractionAccountingForCampaigns,
    ).toHaveBeenCalledWith([campaignId]);
  });

  it("keeps accounting behind the same simulator gate", async () => {
    const controller = createController({ simulatorEnabled: false });

    await expect(
      controller.getAccounting({ campaignId: [campaignId] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

function createController({
  simulatorEnabled = true,
  conversations = {
    listExtractionAccountingForCampaigns: vi.fn().mockResolvedValue([]),
  },
}: {
  readonly simulatorEnabled?: boolean;
  readonly conversations?: {
    readonly listExtractionAccountingForCampaigns: ReturnType<typeof vi.fn>;
  };
} = {}): FeedbackBurstController {
  const values: Partial<Record<keyof Environment, unknown>> = {
    NODE_ENV: "development",
    FEEDBACK_PRODUCTION_REHEARSAL_ENABLED: false,
    FEEDBACK_SIMULATOR_ENABLED: simulatorEnabled,
    TRANSPORT_MODE: "simulated",
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;

  return new FeedbackBurstController(
    config,
    {} as Queue,
    conversations as unknown as FeedbackConversationRepository,
  );
}
