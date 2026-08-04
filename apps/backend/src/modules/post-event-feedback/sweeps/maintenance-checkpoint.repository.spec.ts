import type {
  AppTransaction,
  FeedbackMaintenanceCheckpointRow,
} from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import { FeedbackMaintenanceCheckpointRepository } from "./maintenance-checkpoint.repository.js";

const now = new Date("2026-08-03T12:00:00.000Z");
const cursorAt = new Date("2026-08-03T11:59:00.000Z");
const cursorId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";

describe("FeedbackMaintenanceCheckpointRepository", () => {
  it("creates and row-locks the globally shared conversation checkpoint", async () => {
    const { transaction, forUpdate, values, onConflictDoNothing } =
      checkpointTransaction(
        checkpointRow({
          task: "conversation_due",
          cursorAt,
          cursorId,
        }),
      );
    const repository = new FeedbackMaintenanceCheckpointRepository();

    await expect(repository.lockConversationDue(transaction)).resolves.toEqual({
      nextActionAt: cursorAt,
      conversationId: cursorId,
    });

    expect(values).toHaveBeenCalledWith({ task: "conversation_due" });
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
    expect(forUpdate).toHaveBeenCalledWith("update");
  });

  it("stores summary UUID fairness without inventing a timestamp cursor", async () => {
    const { transaction, set } = checkpointTransaction(
      checkpointRow({ task: "summary_auto" }),
    );
    const repository = new FeedbackMaintenanceCheckpointRepository();

    await repository.saveAutomaticSummary(transaction, cursorId);

    expect(set).toHaveBeenCalledWith({
      cursorAt: null,
      cursorId,
      updatedAt: expect.anything(),
    });
  });

  it("reads and stores the pending-ingress created-at/id boundary", async () => {
    const locked = checkpointTransaction(
      checkpointRow({ task: "ingress_pending", cursorAt, cursorId }),
    );
    const repository = new FeedbackMaintenanceCheckpointRepository();

    await expect(
      repository.lockPendingIngress(locked.transaction),
    ).resolves.toEqual({ createdAt: cursorAt, ingressId: cursorId });
    expect(locked.values).toHaveBeenCalledWith({ task: "ingress_pending" });
    expect(locked.forUpdate).toHaveBeenCalledWith("update");

    await repository.savePendingIngress(locked.transaction, {
      createdAt: cursorAt,
      ingressId: cursorId,
    });
    expect(locked.set).toHaveBeenCalledWith({
      cursorAt,
      cursorId,
      updatedAt: expect.anything(),
    });
  });

  it("maps pending-summary requested-at/campaign-id onto the timed cursor", async () => {
    const locked = checkpointTransaction(
      checkpointRow({ task: "summary_pending", cursorAt, cursorId }),
    );
    const repository = new FeedbackMaintenanceCheckpointRepository();

    await expect(
      repository.lockPendingSummary(locked.transaction),
    ).resolves.toEqual({ requestedAt: cursorAt, campaignId: cursorId });
    expect(locked.values).toHaveBeenCalledWith({ task: "summary_pending" });
    expect(locked.forUpdate).toHaveBeenCalledWith("update");

    await repository.savePendingSummary(locked.transaction, {
      requestedAt: cursorAt,
      campaignId: cursorId,
    });
    expect(locked.set).toHaveBeenCalledWith({
      cursorAt,
      cursorId,
      updatedAt: expect.anything(),
    });
  });

  it("maps campaign-resume due-at/campaign-id onto the timed cursor", async () => {
    const locked = checkpointTransaction(
      checkpointRow({ task: "campaign_resume", cursorAt, cursorId }),
    );
    const repository = new FeedbackMaintenanceCheckpointRepository();

    await expect(
      repository.lockCampaignResume(locked.transaction),
    ).resolves.toEqual({ dueAt: cursorAt, campaignId: cursorId });
    expect(locked.values).toHaveBeenCalledWith({ task: "campaign_resume" });
    expect(locked.forUpdate).toHaveBeenCalledWith("update");

    await repository.saveCampaignResume(locked.transaction, {
      dueAt: cursorAt,
      campaignId: cursorId,
    });
    expect(locked.set).toHaveBeenCalledWith({
      cursorAt,
      cursorId,
      updatedAt: expect.anything(),
    });
  });

  it("fails closed if a conversation checkpoint violates its paired shape", async () => {
    const { transaction } = checkpointTransaction(
      checkpointRow({
        task: "conversation_due",
        cursorAt,
        cursorId: null,
      }),
    );
    const repository = new FeedbackMaintenanceCheckpointRepository();

    await expect(repository.lockConversationDue(transaction)).rejects.toThrow(
      "partial cursor",
    );
  });
});

function checkpointTransaction(row: FeedbackMaintenanceCheckpointRow): {
  readonly transaction: AppTransaction;
  readonly values: ReturnType<typeof vi.fn>;
  readonly onConflictDoNothing: ReturnType<typeof vi.fn>;
  readonly forUpdate: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
} {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  const forUpdate = vi.fn().mockResolvedValue([row]);
  const limit = vi.fn().mockReturnValue({ for: forUpdate });
  const selectWhere = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from });

  const returning = vi.fn().mockResolvedValue([{ task: row.task }]);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  return {
    transaction: { insert, select, update } as unknown as AppTransaction,
    values,
    onConflictDoNothing,
    forUpdate,
    set,
  };
}

function checkpointRow(
  overrides: Partial<FeedbackMaintenanceCheckpointRow>,
): FeedbackMaintenanceCheckpointRow {
  return {
    task: "conversation_due",
    cursorAt: null,
    cursorId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
