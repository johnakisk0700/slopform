import {
  type AppTransaction,
  type FeedbackCampaignSummaryRow,
} from "@slopform/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackCampaignRepository,
  type FeedbackCampaignSummaryExecutionClaim,
} from "../campaign/campaign.repository.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const now = new Date("2026-08-03T12:00:00.000Z");

describe("FeedbackCampaignRepository summary and recovery fences", () => {
  it("keyset-scans campaigns with their nullable summary projection", async () => {
    const secondCampaignId = "9f9f8039-a46f-45f8-b406-da4112c83ee5";
    const limit = vi.fn().mockResolvedValue([
      {
        campaignId,
        summaryCampaignId: campaignId,
        summaryStatus: "ready",
        summaryTrigger: "manual",
        summaryRequestedAt: now,
        summaryIsPartial: false,
        summaryOpenConversationCount: 0,
      },
      {
        campaignId: secondCampaignId,
        summaryCampaignId: null,
        summaryStatus: null,
        summaryTrigger: null,
        summaryRequestedAt: null,
        summaryIsPartial: null,
        summaryOpenConversationCount: null,
      },
    ]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const leftJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ leftJoin });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new FeedbackCampaignRepository({
      db: { select },
    } as unknown as DatabaseService);

    await expect(
      repository.listSummaryRecoveryCandidates({
        afterCampaignId: "7d7d6817-e24d-43d6-92f4-b82990a61cc3",
        limit: 100,
      }),
    ).resolves.toEqual([
      {
        campaignId,
        summary: {
          status: "ready",
          trigger: "manual",
          requestedAt: now,
          isPartial: false,
          openConversationCount: 0,
        },
      },
      { campaignId: secondCampaignId, summary: null },
    ]);

    const predicate = where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"feedback_campaigns"."id" >');
    expect(query.params).toEqual(["7d7d6817-e24d-43d6-92f4-b82990a61cc3"]);
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("keyset-scans pending summaries by requested-at and campaign-id", async () => {
    const after = {
      requestedAt: now,
      campaignId,
    };
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new FeedbackCampaignRepository({
      db: { select },
    } as unknown as DatabaseService);

    await expect(
      repository.listPendingSummaries({ after, limit: 50 }),
    ).resolves.toEqual([]);

    const predicate = where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"feedback_campaign_summaries"."status" =');
    expect(query.sql).toContain(
      '"feedback_campaign_summaries"."requested_at" >',
    );
    expect(query.sql).toContain(
      '"feedback_campaign_summaries"."campaign_id" >',
    );
    expect(query.params).toEqual([
      "pending",
      now.toISOString(),
      now.toISOString(),
      campaignId,
    ]);
    expect(orderBy).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
    expect(limit).toHaveBeenCalledWith(50);
  });

  it("allocates resume generations by due-at/id without locking campaign rows", async () => {
    const after = { dueAt: now, campaignId };
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new FeedbackCampaignRepository({
      db: { select },
    } as unknown as DatabaseService);

    await expect(
      repository.listPendingResumeCandidates({ after, limit: 100 }),
    ).resolves.toEqual([]);

    const predicate = where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"feedback_campaigns"."status" =');
    expect(query.sql).toContain(
      '"feedback_campaigns"."resume_applied_generation" < "feedback_campaigns"."resume_generation"',
    );
    expect(query.sql).toContain(
      '"feedback_campaigns"."resume_due_at" is not null',
    );
    expect(query.sql).toContain('"feedback_campaigns"."resume_due_at" >');
    expect(query.sql).toContain('"feedback_campaigns"."id" >');
    expect(query.params).toEqual([
      "launched",
      now.toISOString(),
      now.toISOString(),
      campaignId,
    ]);
    expect(orderBy).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("re-locks only the exact allocated resume generation", async () => {
    const forUpdate = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const transaction = { select } as unknown as AppTransaction;
    const repository = new FeedbackCampaignRepository({} as DatabaseService);

    await expect(
      repository.findPendingResumeCandidateForUpdate(transaction, {
        campaignId,
        generation: 4,
      }),
    ).resolves.toBeUndefined();

    const predicate = where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"feedback_campaigns"."id" =');
    expect(query.sql).toContain('"feedback_campaigns"."resume_generation" =');
    expect(query.sql).toContain(
      '"feedback_campaigns"."resume_applied_generation" <',
    );
    expect(query.params).toEqual([campaignId, "launched", 4, 4]);
    expect(forUpdate).toHaveBeenCalledWith("update");
  });

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

  it("includes epoch, token and live lease in both terminal CAS writes", async () => {
    const predicates: SQL[] = [];
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockImplementation((predicate: SQL) => {
      predicates.push(predicate);
      return { returning };
    });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const transaction = { update } as unknown as AppTransaction;
    const repository = new FeedbackCampaignRepository({} as DatabaseService);
    const claim: FeedbackCampaignSummaryExecutionClaim = {
      campaignId,
      attempt: 2,
      epoch: 7,
      token: "22222222-2222-4222-8222-222222222222",
      claimExpiresAt: new Date("2026-08-03T12:07:00.000Z"),
    };

    await expect(
      repository.markSummaryReady(transaction, {
        claim,
        body: "summary",
        model: "openai/gpt-5.6-terra",
        reasoningEffort: "xhigh",
        answerCount: 3,
        noteCount: 1,
        generatedAt: now,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.markSummaryFailed(transaction, {
        claim,
        error: "provider_rejected",
        generatedAt: now,
      }),
    ).resolves.toBeUndefined();

    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) {
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toContain(
        '"feedback_campaign_summaries"."execution_epoch" =',
      );
      expect(query.sql).toContain(
        '"feedback_campaign_summaries"."claim_token" =',
      );
      expect(query.sql).toContain(
        '"feedback_campaign_summaries"."claim_expires_at" > clock_timestamp()',
      );
      expect(query.params).toEqual([
        campaignId,
        2,
        "pending",
        7,
        "22222222-2222-4222-8222-222222222222",
      ]);
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
