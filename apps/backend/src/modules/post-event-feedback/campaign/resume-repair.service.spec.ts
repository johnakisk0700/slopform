import { Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackCampaignRow,
} from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";
import type { FeedbackMaintenanceCheckpointRepository } from "../sweeps/maintenance-checkpoint.repository.js";
import type { FeedbackCampaignRepository } from "./campaign.repository.js";
import {
  FeedbackCampaignResumeRecoveryError,
  FeedbackCampaignResumeRepairService,
} from "./resume-repair.service.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const secondCampaignId = "99eccaa5-9ce6-4dcf-a630-5e35e4ec6f0e";
const dueAt = new Date("2026-08-03T12:00:00.000Z");

describe("FeedbackCampaignResumeRepairService", () => {
  it("admits and acknowledges one durable generation before publishing wakeups", async () => {
    const { service, campaigns, conversations, wakeups } = createService();
    campaigns.findPendingResumeIntentForUpdate.mockResolvedValue(campaignRow());
    conversations.markCampaignWorkDue.mockResolvedValue(731);
    campaigns.acknowledgeResumeIntent.mockResolvedValue(true);
    wakeups.recoverDue.mockResolvedValue({ examined: 1, queued: 1 });

    await expect(
      service.repairCampaign(campaignId, "resume-request"),
    ).resolves.toEqual({
      examined: 1,
      applied: 1,
      conversationsMarked: 731,
      wakeupsPublished: 1,
    });

    expect(conversations.markCampaignWorkDue).toHaveBeenCalledWith({
      campaignId,
      generation: 4,
      nextActionAt: dueAt,
      at: expect.any(Date),
    });
    expect(campaigns.acknowledgeResumeIntent).toHaveBeenCalledWith(
      expect.anything(),
      { campaignId, generation: 4 },
    );
    expect(conversations.markCampaignWorkDue).toHaveBeenCalledBefore(
      campaigns.acknowledgeResumeIntent,
    );
    expect(campaigns.acknowledgeResumeIntent).toHaveBeenCalledBefore(
      wakeups.recoverDue,
    );
  });

  it("is a no-op when the generation was already acknowledged", async () => {
    const { service, conversations, wakeups } = createService();

    await expect(
      service.repairCampaign(campaignId, "resume-replay"),
    ).resolves.toEqual({
      examined: 0,
      applied: 0,
      conversationsMarked: 0,
      wakeupsPublished: 0,
    });
    expect(conversations.markCampaignWorkDue).not.toHaveBeenCalled();
    expect(wakeups.recoverDue).not.toHaveBeenCalled();
  });

  it("replays the same Mongo generation after a crash before PostgreSQL acknowledgement", async () => {
    const { service, campaigns, conversations } = createService();
    campaigns.findPendingResumeIntentForUpdate.mockResolvedValue(campaignRow());
    conversations.markCampaignWorkDue
      .mockResolvedValueOnce(731)
      // The Mongo generation filter makes the replay a no-op.
      .mockResolvedValueOnce(0);
    campaigns.acknowledgeResumeIntent
      .mockRejectedValueOnce(new Error("connection lost before commit"))
      .mockResolvedValueOnce(true);

    await expect(
      service.repairCampaign(campaignId, "resume-first"),
    ).rejects.toThrow("connection lost before commit");
    await expect(
      service.repairCampaign(campaignId, "resume-retry"),
    ).resolves.toMatchObject({
      applied: 1,
      conversationsMarked: 0,
    });

    expect(conversations.markCampaignWorkDue).toHaveBeenCalledTimes(2);
    expect(conversations.markCampaignWorkDue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ campaignId, generation: 4 }),
    );
  });

  it("keeps the durable Mongo work acknowledged when queue publication fails", async () => {
    const { service, campaigns, conversations, wakeups } = createService();
    campaigns.findPendingResumeIntentForUpdate.mockResolvedValue(campaignRow());
    conversations.markCampaignWorkDue.mockResolvedValue(12);
    campaigns.acknowledgeResumeIntent.mockResolvedValue(true);
    wakeups.recoverDue.mockRejectedValue(new Error("redis unavailable"));

    await expect(
      service.repairCampaign(campaignId, "resume-request"),
    ).resolves.toMatchObject({
      applied: 1,
      conversationsMarked: 12,
      wakeupsPublished: 0,
    });
    expect(campaigns.acknowledgeResumeIntent).toHaveBeenCalledOnce();
  });

  it("commits allocation, isolates one failed generation and repairs the next", async () => {
    const { service, campaigns, conversations, checkpoints } = createService();
    const first = campaignRow();
    const second = campaignRow({
      id: secondCampaignId,
      resumeDueAt: new Date(dueAt.getTime() + 1_000),
    });
    campaigns.listPendingResumeCandidates.mockResolvedValue([
      resumeCandidate(first),
      resumeCandidate(second),
    ]);
    campaigns.findPendingResumeCandidateForUpdate
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    conversations.markCampaignWorkDue
      .mockRejectedValueOnce(new Error("bad mongo document"))
      .mockResolvedValueOnce(9);
    campaigns.acknowledgeResumeIntent.mockResolvedValue(true);

    const failure = await service
      .recover("maintenance-resume", 10)
      .catch((error) => error);

    expect(failure).toBeInstanceOf(FeedbackCampaignResumeRecoveryError);
    expect(failure.result).toEqual({
      examined: 2,
      applied: 1,
      conversationsMarked: 9,
      wakeupsPublished: 0,
    });
    expect(checkpoints.saveCampaignResume).toHaveBeenCalledBefore(
      conversations.markCampaignWorkDue,
    );
    expect(
      campaigns.findPendingResumeCandidateForUpdate,
    ).toHaveBeenNthCalledWith(2, expect.anything(), {
      campaignId: secondCampaignId,
      generation: 4,
    });
    expect(campaigns.acknowledgeResumeIntent).toHaveBeenCalledWith(
      expect.anything(),
      { campaignId: secondCampaignId, generation: 4 },
    );
  });

  it("moves a durable cursor past more poison intents than one pass can inspect", async () => {
    const loggerError = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service, campaigns, conversations } = createService();
    const candidates = Array.from({ length: 101 }, (_, index) => {
      const id = resumeCampaignId(index + 1);
      return {
        campaignId: id,
        generation: 4,
        dueAt,
      };
    });
    const healthyId = candidates.at(-1)?.campaignId;
    if (!healthyId) throw new Error("Test candidate fixture had no tail");

    campaigns.listPendingResumeCandidates.mockImplementation(
      async (input: {
        after?: { dueAt: Date; campaignId: string };
        limit?: number;
      }) => {
        const start = input.after
          ? candidates.findIndex(
              (candidate) => candidate.campaignId === input.after?.campaignId,
            ) + 1
          : 0;
        return candidates.slice(start, start + (input.limit ?? 100));
      },
    );
    campaigns.findPendingResumeCandidateForUpdate.mockImplementation(
      async (
        _transaction: AppTransaction,
        input: { campaignId: string; generation: number },
      ) =>
        campaignRow({
          id: input.campaignId,
          resumeGeneration: input.generation,
        }),
    );
    conversations.markCampaignWorkDue.mockImplementation(
      async (input: { campaignId: string }) => {
        if (input.campaignId !== healthyId) {
          throw new Error("poisonous Mongo aggregate");
        }
        return 1;
      },
    );

    const firstFailure = await service
      .recover("maintenance-resume-a")
      .catch((error) => error);
    expect(firstFailure).toBeInstanceOf(FeedbackCampaignResumeRecoveryError);
    expect(firstFailure.result).toMatchObject({ examined: 100, applied: 0 });

    await expect(service.recover("maintenance-resume-b")).resolves.toEqual({
      examined: 1,
      applied: 1,
      conversationsMarked: 1,
      wakeupsPublished: 0,
    });
    expect(campaigns.listPendingResumeCandidates).toHaveBeenLastCalledWith(
      {
        after: {
          dueAt,
          campaignId: resumeCampaignId(100),
        },
        limit: 50,
      },
      expect.anything(),
    );
    loggerError.mockRestore();
  });

  it("wraps a checkpoint at the finite tail before processing", async () => {
    const checkpoints = resumeCheckpointDouble({
      dueAt,
      campaignId: secondCampaignId,
    });
    const { service, campaigns, conversations } = createService({
      checkpoints,
    });
    const first = campaignRow();
    campaigns.listPendingResumeCandidates.mockImplementation(
      async (input: { after?: { campaignId: string } }) =>
        input.after ? [] : [resumeCandidate(first)],
    );
    campaigns.findPendingResumeCandidateForUpdate.mockResolvedValue(first);
    conversations.markCampaignWorkDue.mockResolvedValue(1);

    await expect(
      service.recover("maintenance-resume-wrap", 10),
    ).resolves.toEqual({
      examined: 1,
      applied: 1,
      conversationsMarked: 1,
      wakeupsPublished: 0,
    });

    expect(campaigns.listPendingResumeCandidates).toHaveBeenNthCalledWith(
      1,
      {
        after: { dueAt, campaignId: secondCampaignId },
        limit: 10,
      },
      expect.anything(),
    );
    expect(campaigns.listPendingResumeCandidates).toHaveBeenNthCalledWith(
      2,
      { limit: 10 },
      expect.anything(),
    );
  });
});

function createService(
  options: { checkpoints?: ReturnType<typeof resumeCheckpointDouble> } = {},
) {
  const transaction = {} as AppTransaction;
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  };
  const campaigns = {
    findPendingResumeIntentForUpdate: vi.fn().mockResolvedValue(undefined),
    findPendingResumeCandidateForUpdate: vi.fn().mockResolvedValue(undefined),
    listPendingResumeCandidates: vi.fn().mockResolvedValue([]),
    acknowledgeResumeIntent: vi.fn().mockResolvedValue(true),
  };
  const checkpoints = options.checkpoints ?? resumeCheckpointDouble();
  const conversations = {
    markCampaignWorkDue: vi.fn().mockResolvedValue(0),
  };
  const wakeups = {
    recoverDue: vi.fn().mockResolvedValue({ examined: 0, queued: 0 }),
  };

  return {
    service: new FeedbackCampaignResumeRepairService(
      database as unknown as DatabaseService,
      campaigns as unknown as FeedbackCampaignRepository,
      checkpoints as unknown as FeedbackMaintenanceCheckpointRepository,
      conversations as unknown as FeedbackConversationRepository,
      wakeups as unknown as FeedbackConversationWakeupService,
    ),
    campaigns,
    checkpoints,
    conversations,
    wakeups,
  };
}

function resumeCheckpointDouble(initial?: {
  readonly dueAt: Date;
  readonly campaignId: string;
}): {
  readonly lockCampaignResume: ReturnType<typeof vi.fn>;
  readonly saveCampaignResume: ReturnType<typeof vi.fn>;
} {
  let cursor = initial;
  return {
    lockCampaignResume: vi.fn().mockImplementation(async () => cursor),
    saveCampaignResume: vi
      .fn()
      .mockImplementation(
        async (
          _transaction: AppTransaction,
          next:
            { readonly dueAt: Date; readonly campaignId: string } | undefined,
        ) => {
          cursor = next;
        },
      ),
  };
}

function resumeCandidate(row: FeedbackCampaignRow): {
  readonly campaignId: string;
  readonly generation: number;
  readonly dueAt: Date;
} {
  if (!row.resumeDueAt)
    throw new Error("Resume candidate fixture had no dueAt");
  return {
    campaignId: row.id,
    generation: row.resumeGeneration,
    dueAt: row.resumeDueAt,
  };
}

function resumeCampaignId(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function campaignRow(
  overrides: Partial<FeedbackCampaignRow> = {},
): FeedbackCampaignRow {
  return {
    id: campaignId,
    eventId: "05d56231-dbd0-46e9-ad85-ff86a1e0f5c6",
    questionSetVersion: 2,
    questions: {},
    status: "launched",
    resumeGeneration: 4,
    resumeAppliedGeneration: 3,
    resumeDueAt: dueAt,
    launchedAt: dueAt,
    launchedBy: "admin-1",
    createdAt: dueAt,
    updatedAt: dueAt,
    ...overrides,
  };
}
