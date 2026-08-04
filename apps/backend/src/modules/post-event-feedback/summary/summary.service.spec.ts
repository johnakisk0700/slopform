import type {
  AppTransaction,
  FeedbackCampaignRow,
  FeedbackCampaignSummaryRow,
} from "@join-the-six/database";
import type { ConfigService } from "@nestjs/config";
import { generateText } from "ai";
import type { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { Environment } from "../../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type {
  FeedbackCampaignRepository,
  FeedbackCampaignSummaryExecutionClaim,
} from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "../extraction/results.repository.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackMaintenanceCheckpointRepository } from "../sweeps/maintenance-checkpoint.repository.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import {
  createFeedbackSummarizeCampaignV2JobId,
  FEEDBACK_JOB_NAMES,
} from "../jobs.schemas.js";
import { buildPostEventFeedbackQuestionLaunchSnapshot } from "../question-set.js";
import {
  DEFAULT_FEEDBACK_SUMMARY_MODEL,
  DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT,
  FEEDBACK_SUMMARY_EXECUTION_HEARTBEAT_MS,
  FeedbackSummaryDisabledInSimulatorError,
  FeedbackSummaryGenerationError,
  PostEventFeedbackCampaignSummaryService,
  resolveFeedbackSummaryModel,
  resolveFeedbackSummaryReasoningEffort,
} from "./summary.service.js";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: vi.fn() };
});

const mockedGenerateText = vi.mocked(generateText);

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const eventId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const correlationId = "req-summary-1";
const maintenanceNow = new Date("2026-08-03T12:00:00.000Z");

const campaignRow: FeedbackCampaignRow = {
  id: campaignId,
  eventId,
  questionSetVersion: 1,
  questions: buildPostEventFeedbackQuestionLaunchSnapshot(1),
  status: "launched",
  resumeGeneration: 0,
  resumeAppliedGeneration: 0,
  resumeDueAt: null,
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
  executionEpoch: 0,
  claimToken: null,
  claimExpiresAt: null,
  openConversationCount: 0,
  answerCount: 0,
  noteCount: 0,
  requestedAt: new Date("2026-08-01T12:00:00.000Z"),
  generatedAt: null,
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-01T12:00:00.000Z"),
  ...overrides,
});

const summaryClaim: FeedbackCampaignSummaryExecutionClaim = {
  campaignId,
  attempt: 1,
  epoch: 1,
  token: "22222222-2222-4222-8222-222222222222",
  claimExpiresAt: new Date("2026-08-01T12:07:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGenerateText.mockResolvedValue({
    text: "  generated summary  ",
  } as Awaited<ReturnType<typeof generateText>>);
});

describe("feedback summary configuration", () => {
  it("reserves Terra xhigh as the explicit summary default", () => {
    expect(DEFAULT_FEEDBACK_SUMMARY_MODEL).toBe("openai/gpt-5.6-terra");
    expect(DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT).toBe("xhigh");
  });

  it.each([undefined, "", "   "])(
    "uses documented defaults for an absent or blank value (%s)",
    (configured) => {
      expect(resolveFeedbackSummaryModel(configured)).toBe(
        DEFAULT_FEEDBACK_SUMMARY_MODEL,
      );
      expect(resolveFeedbackSummaryReasoningEffort(configured)).toBe(
        DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT,
      );
    },
  );
});

describe("PostEventFeedbackCampaignSummaryService", () => {
  it("publishes the execution lease so a pending row is readable", async () => {
    const { service, campaigns } = createService();
    const claimExpiresAt = new Date("2026-08-01T12:07:00.000Z");
    campaigns.findSummaryByCampaignId.mockResolvedValue(
      pendingSummaryRow({ executionEpoch: 3, claimExpiresAt }),
    );

    // A live horizon is a worker inside the model call; the epoch counts the
    // executions this durable attempt has started. Neither is derivable from
    // `status`, which says only that a summary is owed.
    await expect(service.get(campaignId)).resolves.toMatchObject({
      status: "pending",
      attempt: 1,
      executionEpoch: 3,
      claimExpiresAt: claimExpiresAt.toISOString(),
      requestedAt: "2026-08-01T12:00:00.000Z",
    });

    // The token authorizes a write and stays server-side.
    await expect(service.get(campaignId)).resolves.not.toHaveProperty(
      "claimToken",
    );
  });

  it("reports a released claim on a row that is still pending", async () => {
    const { service, campaigns } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(
      pendingSummaryRow({ executionEpoch: 1, claimExpiresAt: null }),
    );

    await expect(service.get(campaignId)).resolves.toMatchObject({
      status: "pending",
      executionEpoch: 1,
      claimExpiresAt: null,
    });
  });

  it("reports no lease for a campaign that never requested a summary", async () => {
    const { service, campaigns } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(undefined);

    await expect(service.get(campaignId)).resolves.toMatchObject({
      status: "none",
      executionEpoch: null,
      claimExpiresAt: null,
    });
  });

  it("repairs a missing wake-up for an existing durable pending row", async () => {
    const { service, campaigns, conversations, queue, auditAppend } =
      createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());

    const result = await service.request(
      campaignId,
      "manual",
      correlationId,
      "admin-1",
    );

    expect(result.status).toBe("pending");
    expect(result.attempt).toBe(1);
    expect(conversations.countOpenForCampaign).not.toHaveBeenCalled();
    expect(campaigns.upsertSummaryPending).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.summarizeCampaignV2,
      {
        schemaVersion: 2,
        campaignId,
        attempt: 1,
        correlationId,
      },
      expect.objectContaining({
        jobId: createFeedbackSummarizeCampaignV2JobId(campaignId, 1),
      }),
    );
    expect(auditAppend).not.toHaveBeenCalled();
  });

  it("serializes concurrent first requests on the campaign row", async () => {
    const { service, campaigns, database, auditAppend } = createService();
    let durableSummary: FeedbackCampaignSummaryRow | undefined;
    let transactionTail = Promise.resolve<unknown>(undefined);
    database.transaction.mockImplementation(
      (work: (transaction: AppTransaction) => Promise<unknown>) => {
        const result = transactionTail.then(() => work({} as AppTransaction));
        transactionTail = result.catch(() => undefined);
        return result;
      },
    );
    campaigns.findSummaryByCampaignId.mockImplementation(
      async () => durableSummary,
    );
    campaigns.upsertSummaryPending.mockImplementation(async () => {
      if (durableSummary) {
        throw new Error("duplicate summary insert");
      }
      durableSummary = pendingSummaryRow();
      return durableSummary;
    });

    const [first, second] = await Promise.all([
      service.request(campaignId, "manual", "request-a", "admin-1"),
      service.request(campaignId, "manual", "request-b", "admin-2"),
    ]);

    expect(first).toMatchObject({ status: "pending", attempt: 1 });
    expect(second).toMatchObject({ status: "pending", attempt: 1 });
    expect(campaigns.findCampaignByIdForUpdate).toHaveBeenCalledTimes(2);
    expect(campaigns.upsertSummaryPending).toHaveBeenCalledTimes(1);
    expect(auditAppend).toHaveBeenCalledTimes(1);
  });

  it("orders a summary-first request before concurrent conversation creation", async () => {
    const { service, campaigns, conversations, database } = createService();
    const trace: string[] = [];
    const summaryCounted = deferred<void>();
    const releaseSummaryCount = deferred<void>();
    let openConversationCount = 0;
    let transactionTail = Promise.resolve<unknown>(undefined);
    database.transaction.mockImplementation(
      (work: (transaction: AppTransaction) => Promise<unknown>) => {
        const result = transactionTail.then(() => work({} as AppTransaction));
        transactionTail = result.catch(() => undefined);
        return result;
      },
    );
    const transact =
      database.transaction as unknown as DatabaseService["transaction"];
    const lockCampaign =
      campaigns.findCampaignByIdForUpdate as unknown as FeedbackCampaignRepository["findCampaignByIdForUpdate"];
    conversations.countOpenForCampaign.mockImplementation(async () => {
      const snapshot = openConversationCount;
      trace.push(`summary:count:${snapshot}`);
      summaryCounted.resolve();
      await releaseSummaryCount.promise;
      return snapshot;
    });
    campaigns.upsertSummaryPending.mockImplementation(
      async (
        _transaction: AppTransaction,
        input: { readonly openConversationCount: number },
      ) => {
        trace.push(`summary:write:${input.openConversationCount}`);
        return pendingSummaryRow({
          isPartial: input.openConversationCount > 0,
          openConversationCount: input.openConversationCount,
        });
      },
    );

    const summary = service.request(campaignId, "all_closed", "summary-first");
    await summaryCounted.promise;
    const startConversation = transact(async (transaction) => {
      await lockCampaign(transaction, campaignId);
      trace.push("conversation:create");
      openConversationCount = 1;
    });
    releaseSummaryCount.resolve();

    await expect(summary).resolves.toMatchObject({
      isPartial: false,
      openConversationCount: 0,
    });
    await startConversation;
    expect(trace).toEqual([
      "summary:count:0",
      "summary:write:0",
      "conversation:create",
    ]);
  });

  it("observes a conversation whose creation won the campaign lock", async () => {
    const { service, campaigns, conversations, database } = createService();
    const trace: string[] = [];
    const conversationCreating = deferred<void>();
    const releaseConversationCreate = deferred<void>();
    let openConversationCount = 0;
    let transactionTail = Promise.resolve<unknown>(undefined);
    database.transaction.mockImplementation(
      (work: (transaction: AppTransaction) => Promise<unknown>) => {
        const result = transactionTail.then(() => work({} as AppTransaction));
        transactionTail = result.catch(() => undefined);
        return result;
      },
    );
    const transact =
      database.transaction as unknown as DatabaseService["transaction"];
    const lockCampaign =
      campaigns.findCampaignByIdForUpdate as unknown as FeedbackCampaignRepository["findCampaignByIdForUpdate"];
    conversations.countOpenForCampaign.mockImplementation(async () => {
      trace.push(`summary:count:${openConversationCount}`);
      return openConversationCount;
    });
    campaigns.upsertSummaryPending.mockImplementation(
      async (
        _transaction: AppTransaction,
        input: { readonly openConversationCount: number },
      ) => {
        trace.push(`summary:write:${input.openConversationCount}`);
        return pendingSummaryRow({
          isPartial: input.openConversationCount > 0,
          openConversationCount: input.openConversationCount,
        });
      },
    );

    const startConversation = transact(async (transaction) => {
      await lockCampaign(transaction, campaignId);
      trace.push("conversation:create:start");
      conversationCreating.resolve();
      await releaseConversationCreate.promise;
      openConversationCount = 1;
      trace.push("conversation:create:commit");
    });
    await conversationCreating.promise;
    const summary = service.request(
      campaignId,
      "all_closed",
      "conversation-first",
    );
    releaseConversationCreate.resolve();

    await startConversation;
    await expect(summary).resolves.toMatchObject({
      isPartial: true,
      openConversationCount: 1,
    });
    expect(trace).toEqual([
      "conversation:create:start",
      "conversation:create:commit",
      "summary:count:1",
      "summary:write:1",
    ]);
  });

  it("converts only the exact durable pending V1 summary attempt", async () => {
    const { service, campaigns, queue } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());

    await expect(
      service.convertLegacyWakeup({
        campaignId,
        attempt: 1,
        correlationId,
      }),
    ).resolves.toBe(createFeedbackSummarizeCampaignV2JobId(campaignId, 1));

    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.summarizeCampaignV2,
      expect.objectContaining({ campaignId, attempt: 1 }),
      expect.objectContaining({
        jobId: createFeedbackSummarizeCampaignV2JobId(campaignId, 1),
      }),
    );

    queue.add.mockClear();
    campaigns.findSummaryByCampaignId.mockResolvedValue(
      pendingSummaryRow({ attempt: 2 }),
    );
    await expect(
      service.convertLegacyWakeup({
        campaignId,
        attempt: 1,
        correlationId,
      }),
    ).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(["ready", "failed"] as const)(
    "does not convert a retained V1 wake-up after the durable attempt is %s",
    async (status) => {
      const { service, campaigns, queue } = createService();
      campaigns.findSummaryByCampaignId.mockResolvedValue(
        pendingSummaryRow({ status }),
      );

      await expect(
        service.convertLegacyWakeup({
          campaignId,
          attempt: 1,
          correlationId,
        }),
      ).resolves.toBeUndefined();

      expect(queue.getJob).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(mockedGenerateText).not.toHaveBeenCalled();
    },
  );

  it("keeps a live V2 summary wake-up instead of publishing a duplicate", async () => {
    const { service, queue } = createService();
    const existing = {
      getState: vi.fn().mockResolvedValue("active"),
      remove: vi.fn(),
    };
    queue.getJob.mockResolvedValue(existing);

    await expect(
      service.ensurePendingQueued(pendingSummaryRow(), correlationId),
    ).resolves.toBe(createFeedbackSummarizeCampaignV2JobId(campaignId, 1));

    expect(existing.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("replaces a terminal V2 summary wake-up while PostgreSQL is still pending", async () => {
    const { service, queue } = createService();
    const existing = {
      getState: vi.fn().mockResolvedValue("failed"),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    queue.getJob.mockResolvedValue(existing);

    await service.ensurePendingQueued(pendingSummaryRow(), correlationId);

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.summarizeCampaignV2,
      expect.objectContaining({ campaignId, attempt: 1 }),
      expect.objectContaining({
        jobId: createFeedbackSummarizeCampaignV2JobId(campaignId, 1),
      }),
    );
  });

  it("leaves a terminal-job removal race for the next repair pass", async () => {
    const { service, queue } = createService();
    const existing = {
      getState: vi.fn().mockResolvedValue("completed"),
      remove: vi.fn().mockRejectedValue(new Error("job became active")),
    };
    queue.getJob.mockResolvedValue(existing);

    await expect(
      service.ensurePendingQueued(pendingSummaryRow(), correlationId),
    ).resolves.toBe(createFeedbackSummarizeCampaignV2JobId(campaignId, 1));

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does nothing in maybeRequest when conversations remain open", async () => {
    const { service, conversations, campaigns, queue } = createService();
    conversations.countOpenForCampaign.mockResolvedValue(2);

    await service.maybeRequestAfterConversationClosed(
      campaignId,
      correlationId,
    );

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
      FEEDBACK_JOB_NAMES.summarizeCampaignV2,
      {
        schemaVersion: 2,
        campaignId,
        attempt: 1,
        correlationId,
      },
      expect.objectContaining({
        jobId: createFeedbackSummarizeCampaignV2JobId(campaignId, 1),
      }),
    );
  });

  it("requeues every durable pending summary discovered by maintenance", async () => {
    const { service, campaigns, queue, checkpoints } = createService();
    campaigns.listPendingSummaries.mockResolvedValue([
      pendingSummaryRow(),
      pendingSummaryRow({
        campaignId: "7d7d6817-e24d-43d6-92f4-b82990a61cc3",
        attempt: 3,
      }),
    ]);

    await expect(service.recoverPending(correlationId)).resolves.toBe(2);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(campaigns.listPendingSummaries).toHaveBeenCalledWith(
      { limit: 50 },
      expect.anything(),
    );
    expect(checkpoints.savePendingSummary).toHaveBeenCalledBefore(queue.add);
  });

  it("moves a live-job prefix past the page limit so the next summary is reached", async () => {
    const { service, campaigns, queue } = createService();
    const summaries = Array.from({ length: 51 }, (_, index) =>
      pendingSummaryRow({
        campaignId: recoveryCampaignId(index + 1),
        requestedAt: maintenanceNow,
      }),
    );
    campaigns.listPendingSummaries.mockImplementation(
      async (input: {
        after?: { requestedAt: Date; campaignId: string };
        limit?: number;
      }) => {
        const start = input.after
          ? summaries.findIndex(
              (summary) => summary.campaignId === input.after?.campaignId,
            ) + 1
          : 0;
        return summaries.slice(start, start + (input.limit ?? 50));
      },
    );
    const liveJob = {
      getState: vi.fn().mockResolvedValue("waiting"),
    };
    queue.getJob.mockImplementation(async () => liveJob);

    await expect(service.recoverPending("summary-prefix-a")).resolves.toBe(50);
    expect(queue.add).not.toHaveBeenCalled();

    queue.getJob.mockResolvedValue(undefined);
    await expect(service.recoverPending("summary-prefix-b")).resolves.toBe(1);

    expect(campaigns.listPendingSummaries).toHaveBeenLastCalledWith(
      {
        after: {
          requestedAt: maintenanceNow,
          campaignId: recoveryCampaignId(50),
        },
        limit: 50,
      },
      expect.anything(),
    );
    expect(queue.add).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.summarizeCampaignV2,
      expect.objectContaining({ campaignId: recoveryCampaignId(51) }),
      expect.anything(),
    );
  });

  it("isolates a pending-summary enqueue failure after advancing the cursor", async () => {
    const { service, campaigns, queue, checkpoints } = createService();
    campaigns.listPendingSummaries.mockResolvedValue([
      pendingSummaryRow(),
      pendingSummaryRow({ campaignId: recoveryCampaignId(2) }),
    ]);
    queue.add
      .mockRejectedValueOnce(new Error("poisonous BullMQ job"))
      .mockResolvedValueOnce(undefined);

    await expect(service.recoverPending(correlationId)).rejects.toThrow(
      "item failures",
    );

    expect(checkpoints.savePendingSummary).toHaveBeenCalledBefore(queue.add);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it("wraps a pending-summary checkpoint at the finite tail", async () => {
    const checkpoints = summaryCheckpointDouble(undefined, {
      requestedAt: maintenanceNow,
      campaignId: recoveryCampaignId(2),
    });
    const { service, campaigns, queue } = createService({ checkpoints });
    campaigns.listPendingSummaries.mockImplementation(
      async (input: { after?: { campaignId: string } }) =>
        input.after ? [] : [pendingSummaryRow()],
    );

    await expect(service.recoverPending("summary-wrap")).resolves.toBe(1);

    expect(campaigns.listPendingSummaries).toHaveBeenNthCalledWith(
      1,
      {
        after: {
          requestedAt: maintenanceNow,
          campaignId: recoveryCampaignId(2),
        },
        limit: 50,
      },
      expect.anything(),
    );
    expect(campaigns.listPendingSummaries).toHaveBeenNthCalledWith(
      2,
      { limit: 50 },
      expect.anything(),
    );
    expect(checkpoints.savePendingSummary).toHaveBeenCalledBefore(queue.add);
  });

  it("reconstructs automatic summary intent after the last Mongo close", async () => {
    const { service, campaigns, conversations, queue } = createService();
    const closedAt = new Date("2026-07-25T03:00:00.000Z");
    campaigns.listSummaryRecoveryCandidates.mockResolvedValue([
      { campaignId, summary: null },
    ]);
    conversations.listLifecycleStatsForCampaigns.mockResolvedValue([
      { campaignId, totalCount: 2, openCount: 0, latestClosedAt: closedAt },
    ]);
    campaigns.upsertSummaryPending.mockResolvedValue(pendingSummaryRow());

    await expect(
      service.recoverAutomaticIntent(correlationId),
    ).resolves.toEqual({ examined: 1, requested: 1 });

    expect(campaigns.upsertSummaryPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        campaignId,
        trigger: "all_closed",
        isPartial: false,
        openConversationCount: 0,
      }),
    );
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("ignores zero-conversation and still-open campaigns during summary repair", async () => {
    const { service, campaigns, conversations } = createService();
    const secondCampaignId = "7d7d6817-e24d-43d6-92f4-b82990a61cc3";
    campaigns.listSummaryRecoveryCandidates.mockResolvedValue([
      { campaignId, summary: null },
      { campaignId: secondCampaignId, summary: null },
    ]);
    conversations.listLifecycleStatsForCampaigns.mockResolvedValue([
      {
        campaignId: secondCampaignId,
        totalCount: 2,
        openCount: 1,
        latestClosedAt: new Date("2026-07-25T03:00:00.000Z"),
      },
    ]);

    await expect(
      service.recoverAutomaticIntent(correlationId),
    ).resolves.toEqual({ examined: 2, requested: 0 });
    expect(campaigns.upsertSummaryPending).not.toHaveBeenCalled();
  });

  it("refreshes a partial or older summary but leaves a post-close summary alone", async () => {
    const { service, campaigns, conversations } = createService();
    const staleCampaignId = "7d7d6817-e24d-43d6-92f4-b82990a61cc3";
    const freshCampaignId = "8e8e7928-f35e-44e7-a3f5-c93001b72dd4";
    const closedAt = new Date("2026-07-25T03:00:00.000Z");
    const summary = (requestedAt: Date, isPartial = false) => ({
      status: "ready",
      trigger: "manual",
      requestedAt,
      isPartial,
      openConversationCount: isPartial ? 1 : 0,
    });
    campaigns.listSummaryRecoveryCandidates.mockResolvedValue([
      {
        campaignId: staleCampaignId,
        summary: summary(new Date("2026-07-25T02:00:00.000Z"), true),
      },
      {
        campaignId: freshCampaignId,
        summary: summary(new Date("2026-07-25T04:00:00.000Z")),
      },
    ]);
    conversations.listLifecycleStatsForCampaigns.mockResolvedValue([
      {
        campaignId: staleCampaignId,
        totalCount: 1,
        openCount: 0,
        latestClosedAt: closedAt,
      },
      {
        campaignId: freshCampaignId,
        totalCount: 1,
        openCount: 0,
        latestClosedAt: closedAt,
      },
    ]);
    campaigns.findCampaignById.mockImplementation(async (id: string) => ({
      ...campaignRow,
      id,
    }));
    campaigns.findCampaignByIdForUpdate.mockImplementation(
      async (_transaction: AppTransaction, id: string) => ({
        ...campaignRow,
        id,
      }),
    );
    campaigns.upsertSummaryPending.mockImplementation(
      async (_transaction: AppTransaction, input: { campaignId: string }) =>
        pendingSummaryRow({ campaignId: input.campaignId }),
    );

    await expect(
      service.recoverAutomaticIntent(correlationId),
    ).resolves.toEqual({ examined: 2, requested: 1 });
    expect(campaigns.upsertSummaryPending).toHaveBeenCalledTimes(1);
    expect(campaigns.upsertSummaryPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ campaignId: staleCampaignId }),
    );
  });

  it("continues the automatic scan from a checkpoint shared by replicas", async () => {
    const checkpoints = summaryCheckpointDouble();
    const first = createService({ checkpoints });
    const second = createService({ checkpoints });
    first.campaigns.listSummaryRecoveryCandidates.mockImplementation(
      async (input: { afterCampaignId?: string; limit?: number }) => {
        const start = input.afterCampaignId
          ? Number.parseInt(input.afterCampaignId.slice(-12), 10) + 1
          : 1;
        return Array.from({ length: input.limit ?? 100 }, (_, index) => ({
          campaignId: recoveryCampaignId(start + index),
          summary: null,
        }));
      },
    );
    second.campaigns.listSummaryRecoveryCandidates.mockResolvedValue([]);

    await expect(
      first.service.recoverAutomaticIntent("replica-a"),
    ).resolves.toEqual({ examined: 500, requested: 0 });
    await expect(
      second.service.recoverAutomaticIntent("replica-b"),
    ).resolves.toEqual({ examined: 0, requested: 0 });

    expect(second.campaigns.listSummaryRecoveryCandidates).toHaveBeenCalledWith(
      {
        afterCampaignId: recoveryCampaignId(500),
        limit: 100,
      },
      expect.anything(),
    );
  });

  it("isolates a poisonous automatic-summary candidate and advances first", async () => {
    const failedCampaignId = recoveryCampaignId(1);
    const healthyCampaignId = recoveryCampaignId(2);
    const { service, campaigns, conversations, checkpoints, queue } =
      createService();
    campaigns.listSummaryRecoveryCandidates.mockResolvedValue([
      { campaignId: failedCampaignId, summary: null },
      { campaignId: healthyCampaignId, summary: null },
    ]);
    conversations.listLifecycleStatsForCampaigns.mockResolvedValue([
      {
        campaignId: failedCampaignId,
        totalCount: 1,
        openCount: 0,
        latestClosedAt: maintenanceNow,
      },
      {
        campaignId: healthyCampaignId,
        totalCount: 1,
        openCount: 0,
        latestClosedAt: maintenanceNow,
      },
    ]);
    campaigns.findSummaryByCampaignId
      .mockRejectedValueOnce(new Error("poisonous campaign"))
      .mockResolvedValue(undefined);
    campaigns.upsertSummaryPending.mockResolvedValue(
      pendingSummaryRow({ campaignId: healthyCampaignId }),
    );

    await expect(service.recoverAutomaticIntent(correlationId)).rejects.toThrow(
      "item failures",
    );

    expect(checkpoints.saveAutomaticSummary).toHaveBeenCalledBefore(
      conversations.listLifecycleStatsForCampaigns,
    );
    expect(campaigns.findSummaryByCampaignId).toHaveBeenCalledWith(
      failedCampaignId,
    );
    expect(campaigns.findSummaryByCampaignId).toHaveBeenCalledWith(
      healthyCampaignId,
    );
    expect(campaigns.upsertSummaryPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ campaignId: healthyCampaignId }),
    );
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("suppresses automatic summaries while the simulator is enabled", async () => {
    const { service, conversations, campaigns, queue } = createService({
      simulatorEnabled: true,
    });

    await service.notifyIfLastConversationClosed(
      campaignId,
      correlationId,
      true,
    );

    expect(conversations.countOpenForCampaign).not.toHaveBeenCalled();
    expect(campaigns.findSummaryByCampaignId).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("allows an explicit manual summary request while the simulator is enabled", async () => {
    const { service, campaigns, queue } = createService({
      simulatorEnabled: true,
    });
    campaigns.upsertSummaryPending.mockResolvedValue(
      pendingSummaryRow({ trigger: "manual" }),
    );

    await expect(
      service.request(campaignId, "manual", correlationId, "admin-1"),
    ).resolves.toMatchObject({ status: "pending", trigger: "manual" });

    expect(campaigns.upsertSummaryPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trigger: "manual" }),
    );
    expect(queue.add).toHaveBeenCalledOnce();
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("rejects a direct automatic summary request while the simulator is enabled", async () => {
    const { service, campaigns, queue } = createService({
      simulatorEnabled: true,
    });

    await expect(
      service.request(campaignId, "all_closed", correlationId),
    ).rejects.toBeInstanceOf(FeedbackSummaryDisabledInSimulatorError);

    expect(campaigns.upsertSummaryPending).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("terminally suppresses a retained automatic summary job in simulator mode", async () => {
    const { service, campaigns, results } = createService({
      simulatorEnabled: true,
    });
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());

    await service.run(
      { schemaVersion: 2, campaignId, attempt: 1, correlationId },
      { terminalOnFailure: false },
    );

    expect(campaigns.markSummaryFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claim: expect.objectContaining({ campaignId, attempt: 1 }),
        error: "disabled_in_simulator",
      }),
    );
    expect(results.listAnswersByCampaign).not.toHaveBeenCalled();
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("runs an explicitly requested manual summary in simulator mode", async () => {
    const { service, campaigns } = createService({ simulatorEnabled: true });
    campaigns.findSummaryByCampaignId.mockResolvedValue(
      pendingSummaryRow({ trigger: "manual" }),
    );

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: false },
      ),
    ).resolves.toBe("completed");

    expect(mockedGenerateText).toHaveBeenCalledOnce();
    expect(campaigns.markSummaryFailed).not.toHaveBeenCalled();
    expect(campaigns.markSummaryReady).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claim: summaryClaim }),
    );
  });

  it("admits only the durable claim owner to the provider", async () => {
    const { service, campaigns } = createService();
    const provider = deferred<Awaited<ReturnType<typeof generateText>>>();
    mockedGenerateText.mockReturnValue(provider.promise);
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());
    campaigns.tryClaimSummaryExecution
      .mockResolvedValueOnce({ outcome: "claimed", claim: summaryClaim })
      .mockResolvedValueOnce({ outcome: "busy" });

    const owner = service.run(
      { schemaVersion: 2, campaignId, attempt: 1, correlationId },
      { terminalOnFailure: false },
    );
    await vi.waitFor(() => expect(mockedGenerateText).toHaveBeenCalledOnce());

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: false },
      ),
    ).resolves.toBe("claim_busy");
    expect(mockedGenerateText).toHaveBeenCalledOnce();

    provider.resolve({
      text: "generated summary",
    } as Awaited<ReturnType<typeof generateText>>);
    await expect(owner).resolves.toBe("completed");
  });

  it("revalidates and renews the claim after provider capacity is granted", async () => {
    const { service, campaigns } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());
    campaigns.renewSummaryExecutionClaim.mockResolvedValue(undefined);

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: false },
      ),
    ).resolves.toBe("claim_busy");

    expect(campaigns.renewSummaryExecutionClaim).toHaveBeenCalledWith(
      expect.anything(),
      summaryClaim,
      expect.any(Number),
    );
    expect(mockedGenerateText).not.toHaveBeenCalled();
    expect(campaigns.markSummaryReady).not.toHaveBeenCalled();
    expect(campaigns.markSummaryFailed).not.toHaveBeenCalled();
  });

  it("does not let a stale token mark a provider result ready", async () => {
    const { service, campaigns } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());
    campaigns.markSummaryReady.mockResolvedValue(undefined);

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: false },
      ),
    ).resolves.toBe("claim_busy");

    expect(campaigns.markSummaryReady).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claim: summaryClaim }),
    );
  });

  it("does not let a stale token mark a terminal failure", async () => {
    const { service, campaigns } = createService();
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());
    campaigns.markSummaryFailed.mockResolvedValue(undefined);
    mockedGenerateText.mockRejectedValue(
      new FeedbackSummaryGenerationError(false, "provider_rejected"),
    );

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: true },
      ),
    ).resolves.toBe("claim_busy");

    expect(campaigns.markSummaryFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claim: summaryClaim }),
    );
  });

  it("keeps retryable failures pending until the final BullMQ attempt", async () => {
    const { service, campaigns } = createService();
    const transient = new Error("provider timeout");
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());
    mockedGenerateText.mockRejectedValue(transient);

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: false },
      ),
    ).rejects.toBe(transient);

    expect(campaigns.markSummaryFailed).not.toHaveBeenCalled();
    expect(campaigns.releaseSummaryExecutionClaim).toHaveBeenCalledWith(
      expect.anything(),
      summaryClaim,
    );
  });

  it("uses the live claim for final-attempt failure", async () => {
    const { service, campaigns } = createService();
    const transient = new Error("provider timeout");
    campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());
    mockedGenerateText.mockRejectedValue(transient);

    await expect(
      service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: true },
      ),
    ).rejects.toBe(transient);

    expect(campaigns.markSummaryFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claim: summaryClaim,
        error: "unknown",
      }),
    );
  });

  it("renews the durable lease while a provider call is in flight", async () => {
    vi.useFakeTimers();
    try {
      const { service, campaigns } = createService();
      const provider = deferred<Awaited<ReturnType<typeof generateText>>>();
      mockedGenerateText.mockReturnValue(provider.promise);
      campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());

      const run = service.run(
        { schemaVersion: 2, campaignId, attempt: 1, correlationId },
        { terminalOnFailure: false },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedGenerateText).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(
        FEEDBACK_SUMMARY_EXECUTION_HEARTBEAT_MS,
      );
      expect(campaigns.renewSummaryExecutionClaim).toHaveBeenCalledTimes(2);

      provider.resolve({
        text: "generated summary",
      } as Awaited<ReturnType<typeof generateText>>);
      await expect(run).resolves.toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      version: 1 as const,
      expectedInstruction: "Αναλύεις campaign με ερωτηματολόγιο V1",
      excludedInstruction: "Κράτησε χωριστές τις τέσσερις βαθμολογίες",
    },
    {
      version: 2 as const,
      expectedInstruction: "Αναλύεις campaign με ερωτηματολόγιο V2",
      excludedInstruction: "Το liked είναι η απάντηση V1",
    },
  ])(
    "builds a V$version prompt from the campaign's persisted question-set version",
    async ({ version, expectedInstruction, excludedInstruction }) => {
      const { service, campaigns } = createService();
      campaigns.findCampaignById.mockResolvedValue({
        ...campaignRow,
        questionSetVersion: version,
        questions: buildPostEventFeedbackQuestionLaunchSnapshot(version),
      });
      campaigns.findSummaryByCampaignId.mockResolvedValue(pendingSummaryRow());

      await service.run(
        {
          schemaVersion: 2,
          campaignId,
          attempt: 1,
          correlationId,
        },
        { terminalOnFailure: false },
      );

      const options = mockedGenerateText.mock.calls[0]?.[0];
      const message = options?.messages?.[0];
      const prompt =
        message && "content" in message && typeof message.content === "string"
          ? message.content
          : "";
      expect(prompt).toContain(expectedInstruction);
      expect(prompt).not.toContain(excludedInstruction);
      if (version === 2) {
        expect(prompt).toContain("Κράτησε χωριστές τις τέσσερις βαθμολογίες");
      }
      expect(campaigns.findCampaignById).toHaveBeenCalledWith(campaignId);
      expect(campaigns.markSummaryReady).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          claim: expect.objectContaining({ campaignId, attempt: 1 }),
          body: "generated summary",
        }),
      );
    },
  );
});

function createService(
  options: {
    simulatorEnabled?: boolean;
    checkpoints?: ReturnType<typeof summaryCheckpointDouble>;
  } = {},
): {
  service: PostEventFeedbackCampaignSummaryService;
  campaigns: {
    findCampaignById: ReturnType<typeof vi.fn>;
    findCampaignByIdForUpdate: ReturnType<typeof vi.fn>;
    findSummaryByCampaignId: ReturnType<typeof vi.fn>;
    upsertSummaryPending: ReturnType<typeof vi.fn>;
    listPendingSummaries: ReturnType<typeof vi.fn>;
    listSummaryRecoveryCandidates: ReturnType<typeof vi.fn>;
    tryClaimSummaryExecution: ReturnType<typeof vi.fn>;
    renewSummaryExecutionClaim: ReturnType<typeof vi.fn>;
    releaseSummaryExecutionClaim: ReturnType<typeof vi.fn>;
    markSummaryReady: ReturnType<typeof vi.fn>;
    markSummaryFailed: ReturnType<typeof vi.fn>;
  };
  conversations: {
    countOpenForCampaign: ReturnType<typeof vi.fn>;
    listLifecycleStatsForCampaigns: ReturnType<typeof vi.fn>;
    listForCampaign: ReturnType<typeof vi.fn>;
  };
  results: {
    listAnswersByCampaign: ReturnType<typeof vi.fn>;
    listNotesByCampaign: ReturnType<typeof vi.fn>;
  };
  participants: {
    findByIds: ReturnType<typeof vi.fn>;
  };
  queue: {
    add: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
  };
  database: {
    transaction: ReturnType<typeof vi.fn>;
  };
  checkpoints: {
    lockPendingSummary: ReturnType<typeof vi.fn>;
    savePendingSummary: ReturnType<typeof vi.fn>;
    lockAutomaticSummary: ReturnType<typeof vi.fn>;
    saveAutomaticSummary: ReturnType<typeof vi.fn>;
  };
  auditAppend: ReturnType<typeof vi.fn>;
} {
  const transaction = {} as AppTransaction;
  const campaigns = {
    findCampaignById: vi.fn().mockResolvedValue(campaignRow),
    findCampaignByIdForUpdate: vi.fn().mockResolvedValue(campaignRow),
    findSummaryByCampaignId: vi.fn().mockResolvedValue(undefined),
    upsertSummaryPending: vi.fn(),
    listPendingSummaries: vi.fn().mockResolvedValue([]),
    listSummaryRecoveryCandidates: vi.fn().mockResolvedValue([]),
    tryClaimSummaryExecution: vi.fn().mockResolvedValue({
      outcome: "claimed",
      claim: summaryClaim,
    }),
    renewSummaryExecutionClaim: vi.fn().mockResolvedValue(summaryClaim),
    releaseSummaryExecutionClaim: vi.fn().mockResolvedValue(true),
    markSummaryReady: vi
      .fn()
      .mockResolvedValue(pendingSummaryRow({ status: "ready" })),
    markSummaryFailed: vi
      .fn()
      .mockResolvedValue(pendingSummaryRow({ status: "failed" })),
  };
  const conversations = {
    countOpenForCampaign: vi.fn().mockResolvedValue(0),
    listLifecycleStatsForCampaigns: vi.fn().mockResolvedValue([]),
    listForCampaign: vi.fn().mockResolvedValue([]),
  };
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(undefined),
  };
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const results = {
    listAnswersByCampaign: vi.fn().mockResolvedValue([]),
    listNotesByCampaign: vi.fn().mockResolvedValue([]),
  };
  const participants = {
    findByIds: vi.fn().mockResolvedValue([]),
  };
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  };
  const checkpoints = options.checkpoints ?? summaryCheckpointDouble();
  const config = {
    get: vi.fn((key: string) => {
      if (key === "OPENAI_API_KEY") {
        return "test-key";
      }
      if (key === "FEEDBACK_SIMULATOR_ENABLED") {
        return options.simulatorEnabled ?? false;
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
      results as unknown as FeedbackResultsRepository,
      participants as unknown as ParticipantsRepository,
      { append: auditAppend } as unknown as AuditRepository,
      checkpoints as unknown as FeedbackMaintenanceCheckpointRepository,
      queue as unknown as Queue,
    ),
    campaigns,
    conversations,
    results,
    participants,
    queue,
    database,
    checkpoints,
    auditAppend,
  };
}

function summaryCheckpointDouble(
  initial?: string,
  pendingInitial?: { readonly requestedAt: Date; readonly campaignId: string },
): {
  readonly lockPendingSummary: ReturnType<typeof vi.fn>;
  readonly savePendingSummary: ReturnType<typeof vi.fn>;
  readonly lockAutomaticSummary: ReturnType<typeof vi.fn>;
  readonly saveAutomaticSummary: ReturnType<typeof vi.fn>;
} {
  let cursor = initial;
  let pendingCursor = pendingInitial;
  return {
    lockPendingSummary: vi.fn().mockImplementation(async () => pendingCursor),
    savePendingSummary: vi
      .fn()
      .mockImplementation(
        async (
          _transaction: AppTransaction,
          next:
            | { readonly requestedAt: Date; readonly campaignId: string }
            | undefined,
        ) => {
          pendingCursor = next;
        },
      ),
    lockAutomaticSummary: vi.fn().mockImplementation(async () => cursor),
    saveAutomaticSummary: vi
      .fn()
      .mockImplementation(
        async (_transaction: AppTransaction, next: string | undefined) => {
          cursor = next;
        },
      ),
  };
}

function recoveryCampaignId(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
