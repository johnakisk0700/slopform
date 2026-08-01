import type {
  AppTransaction,
  FeedbackCampaignRow,
  FeedbackCampaignSummaryRow,
} from "@join-the-six/database";
import type { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { Environment } from "../../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "../extraction/results.repository.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import {
  createFeedbackSummarizeCampaignJobId,
  FEEDBACK_JOB_NAMES,
} from "../jobs.schemas.js";
import { buildPostEventFeedbackQuestionLaunchSnapshot } from "../question-set.js";
import { PostEventFeedbackCampaignSummaryService } from "./summary.service.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const eventId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const correlationId = "req-summary-1";

const campaignRow: FeedbackCampaignRow = {
  id: campaignId,
  eventId,
  questionSetVersion: 1,
  questions: buildPostEventFeedbackQuestionLaunchSnapshot(),
  status: "launched",
  launchedAt: new Date("2026-07-25T00:00:00.000Z"),
  launchedBy: "admin-1",
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
};

const pendingSummaryRow = (
  overrides: Partial<FeedbackCampaignSummaryRow> = {},
): FeedbackCampaignSummaryRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  campaignId,
  status: "pending",
  body: null,
  model: null,
  reasoningEffort: null,
  isPartial: false,
  trigger: "all_closed",
  error: null,
  attempt: 1,
  openConversationCount: 0,
  answerCount: 0,
  noteCount: 0,
  requestedAt: new Date("2026-08-01T12:00:00.000Z"),
  generatedAt: null,
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-01T12:00:00.000Z"),
  ...overrides,
});

describe("PostEventFeedbackCampaignSummaryService", () => {
  it("returns the existing pending row without re-enqueueing", async () => {
    const { service, campaigns, queue, auditAppend } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());

    const result = await service.request(
      campaignId,
      "manual",
      correlationId,
      "admin-1",
    );

    expect(result.status).toBe("pending");
    expect(result.attempt).toBe(1);
    expect(campaigns.upsertSummaryPending).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalled();
  });

  it("does nothing in maybeRequest when conversations remain open", async () => {
    const { service, conversations, campaigns, queue } = createService();
    conversations.countOpenForCampaign.mockResolvedValue(2);

    await service.maybeRequestAfterConversationClosed(campaignId, correlationId);

    expect(campaigns.findSummaryByCampaignId).not.toHaveBeenCalled();
    expect(campaigns.upsertSummaryPending).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("enqueues summarize when the last conversation closes", async () => {
    const { service, conversations, campaigns, queue } = createService();
    conversations.countOpenForCampaign.mockResolvedValue(0);
    campaigns.findSummaryByCampaignId.mockResolvedValue(undefined);
    campaigns.upsertSummaryPending.mockResolvedValue(pendingSummaryRow());

    await service.notifyIfLastConversationClosed(
      campaignId,
      correlationId,
      true,
    );

    expect(campaigns.upsertSummaryPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        campaignId,
        attempt: 1,
        isPartial: false,
        trigger: "all_closed",
        openConversationCount: 0,
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.summarizeCampaignV1,
      {
        schemaVersion: 1,
        campaignId,
        correlationId,
      },
      expect.objectContaining({
        jobId: createFeedbackSummarizeCampaignJobId(campaignId, 1),
      }),
    );
  });
});

function createService(): {
  service: PostEventFeedbackCampaignSummaryService;
  campaigns: {
    findCampaignById: ReturnType<typeof vi.fn>;
    findSummaryByCampaignId: ReturnType<typeof vi.fn>;
    upsertSummaryPending: ReturnType<typeof vi.fn>;
  };
  conversations: {
    countOpenForCampaign: ReturnType<typeof vi.fn>;
  };
  queue: {
    add: ReturnType<typeof vi.fn>;
  };
  auditAppend: ReturnType<typeof vi.fn>;
} {
  const transaction = {} as AppTransaction;
  const campaigns = {
    findCampaignById: vi.fn().mockResolvedValue(campaignRow),
    findSummaryByCampaignId: vi.fn().mockResolvedValue(undefined),
    upsertSummaryPending: vi.fn(),
    markSummaryReady: vi.fn(),
    markSummaryFailed: vi.fn(),
  };
  const conversations = {
    countOpenForCampaign: vi.fn().mockResolvedValue(0),
    listForCampaign: vi.fn().mockResolvedValue([]),
  };
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
  };
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "OPENAI_API_KEY") {
        return "test-key";
      }
      return undefined;
    }),
  };

  return {
    service: new PostEventFeedbackCampaignSummaryService(
      config as unknown as ConfigService<Environment, true>,
      database as unknown as DatabaseService,
      campaigns as unknown as FeedbackCampaignRepository,
      conversations as unknown as FeedbackConversationRepository,
      {} as FeedbackResultsRepository,
      {} as ParticipantsRepository,
      { append: auditAppend } as unknown as AuditRepository,
      queue as unknown as Queue,
    ),
    campaigns,
    conversations,
    queue,
    auditAppend,
  };
}
