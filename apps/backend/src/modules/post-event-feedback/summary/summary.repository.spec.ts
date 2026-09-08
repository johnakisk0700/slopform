import {
  type AppTransaction,
  type FeedbackCampaignSummaryRow,
} from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const now = new Date("2026-08-03T12:00:00.000Z");

describe("FeedbackCampaignRepository summary and recovery fences", () => {
  it("keeps an unexpired claim busy under a row lock", async () => {
    const row = summaryRow({
      executionEpoch: 4,
      claimToken: "11111111-1111-4111-8111-111111111111",
      claimExpiresAt: new Date("2026-08-03T12:01:00.000Z"),
    });
    const { transaction, forUpdate, update } = claimTransaction(row);
    const repository = new FeedbackCampaignRepository({} as DatabaseService);

    await expect(
      repository.tryClaimSummaryExecution(transaction, {
        campaignId,
        attempt: 1,
        leaseMs: 420_000,
      }),
    ).resolves.toEqual({ outcome: "busy" });

    expect(forUpdate).toHaveBeenCalledWith("update");
    expect(update).not.toHaveBeenCalled();
  });

  it("recovers an expired claim with a new token and monotonic epoch", async () => {
    const row = summaryRow({
      executionEpoch: 4,
      claimToken: "11111111-1111-4111-8111-111111111111",
      claimExpiresAt: new Date("2026-08-03T11:59:00.000Z"),
    });
    const { transaction, forUpdate } = claimTransaction(row);
    const repository = new FeedbackCampaignRepository({} as DatabaseService);

    const result = await repository.tryClaimSummaryExecution(transaction, {
      campaignId,
      attempt: 1,
      leaseMs: 420_000,
    });

    expect(forUpdate).toHaveBeenCalledWith("update");
    expect(result).toMatchObject({
      outcome: "claimed",
      claim: {
        campaignId,
        attempt: 1,
        epoch: 5,
        token: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        claimExpiresAt: new Date("2026-08-03T12:07:00.000Z"),
      },
    });
    if (result.outcome === "claimed") {
      expect(result.claim.token).not.toBe(row.claimToken);
    }
  });
});

function claimTransaction(row: FeedbackCampaignSummaryRow): {
  readonly transaction: AppTransaction;
  readonly forUpdate: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
} {
  const forUpdate = vi.fn().mockResolvedValue([row]);
  const limit = vi.fn().mockReturnValue({ for: forUpdate });
  const selectWhere = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from });

  let values: Partial<FeedbackCampaignSummaryRow> = {};
  const returning = vi.fn().mockImplementation(async () => [
    {
      ...row,
      ...values,
    },
  ]);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi
    .fn()
    .mockImplementation((next: Partial<FeedbackCampaignSummaryRow>) => {
      values = next;
      return { where: updateWhere };
    });
  const update = vi.fn().mockReturnValue({ set });
  const execute = vi.fn().mockResolvedValue({ rows: [{ now }] });

  return {
    transaction: {
      select,
      update,
      execute,
    } as unknown as AppTransaction,
    forUpdate,
    update,
  };
}

function summaryRow(
  overrides: Partial<FeedbackCampaignSummaryRow> = {},
): FeedbackCampaignSummaryRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
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
    requestedAt: now,
    generatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
