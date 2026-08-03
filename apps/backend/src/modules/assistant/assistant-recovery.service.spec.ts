import type { AssistantTurnRow } from "@join-the-six/database";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  ASSISTANT_RECOVERY_BATCH_SIZE,
  ASSISTANT_STALE_TURN_MS,
  AssistantRecoveryService,
} from "./assistant-recovery.service.js";
import type {
  AssistantJobData,
  AssistantJobName,
} from "./assistant.schemas.js";
import type { AssistantService } from "./assistant.service.js";

const staleTurn: AssistantTurnRow = {
  id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  threadId: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
  createdBy: "user_owner",
  requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
  sequence: 1,
  status: "running",
  model: "google/gemini-3.6-flash",
  effort: "low",
  serviceTier: "standard",
  attempt: 1,
  userContent: "Hello",
  assistantContent: null,
  streamedContent: null,
  reasoningContent: null,
  toolCalls: [],
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  totalTokens: null,
  estimatedCostEurMicros: null,
  pricingVersion: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date("2026-07-23T10:00:00.000Z"),
  updatedAt: new Date("2026-07-23T10:00:01.000Z"),
  startedAt: new Date("2026-07-23T10:00:01.000Z"),
  completedAt: null,
};
const secondStaleTurn: AssistantTurnRow = {
  ...staleTurn,
  id: "1ee717e8-c80d-4239-a2a9-cd38515417e4",
  requestId: "4163e1ad-9223-43f5-9955-9a2aaf49aecc",
  sequence: 2,
};

describe("AssistantRecoveryService", () => {
  it("fails a stale nonterminal turn whose durable job is missing", async () => {
    const assistant = {
      findStaleNonterminalTurns: vi.fn().mockResolvedValue([staleTurn]),
      markFailed: vi.fn().mockResolvedValue(true),
    };
    const queue = { getJob: vi.fn().mockResolvedValue(undefined) };
    const service = new AssistantRecoveryService(
      queue as unknown as Queue<AssistantJobData, void, AssistantJobName>,
      assistant as unknown as AssistantService,
    );
    const now = new Date("2026-07-23T11:00:00.000Z");

    await service.reconcileStaleTurns("test", now);

    expect(ASSISTANT_STALE_TURN_MS).toBeGreaterThan(5 * 120_000);
    expect(assistant.findStaleNonterminalTurns).toHaveBeenCalledWith(
      new Date(now.getTime() - ASSISTANT_STALE_TURN_MS),
      ASSISTANT_RECOVERY_BATCH_SIZE,
    );
    expect(assistant.markFailed).toHaveBeenCalledWith(
      staleTurn.id,
      staleTurn.attempt,
      "generation_failed",
      "The assistant turn was interrupted before completion.",
    );
  });

  it("preserves a stale row while its BullMQ job is still live", async () => {
    const assistant = {
      findStaleNonterminalTurns: vi.fn().mockResolvedValue([staleTurn]),
      markFailed: vi.fn(),
    };
    const queue = {
      getJob: vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue("waiting"),
      }),
    };
    const service = new AssistantRecoveryService(
      queue as unknown as Queue<AssistantJobData, void, AssistantJobName>,
      assistant as unknown as AssistantService,
    );

    await service.reconcileStaleTurns("test");

    expect(assistant.markFailed).not.toHaveBeenCalled();
  });

  it("reconciles a stale row after BullMQ already considers its job failed", async () => {
    const assistant = {
      findStaleNonterminalTurns: vi.fn().mockResolvedValue([staleTurn]),
      markFailed: vi.fn().mockResolvedValue(true),
    };
    const queue = {
      getJob: vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue("failed"),
      }),
    };
    const service = new AssistantRecoveryService(
      queue as unknown as Queue<AssistantJobData, void, AssistantJobName>,
      assistant as unknown as AssistantService,
    );

    await service.reconcileStaleTurns("test");

    expect(assistant.markFailed).toHaveBeenCalledOnce();
  });

  it("continues the recovery batch when one turn cannot be materialized", async () => {
    const assistant = {
      findStaleNonterminalTurns: vi
        .fn()
        .mockResolvedValue([staleTurn, secondStaleTurn]),
      markFailed: vi
        .fn()
        .mockRejectedValueOnce(new Error("MongoDB unavailable"))
        .mockResolvedValueOnce(true),
    };
    const queue = { getJob: vi.fn().mockResolvedValue(undefined) };
    const service = new AssistantRecoveryService(
      queue as unknown as Queue<AssistantJobData, void, AssistantJobName>,
      assistant as unknown as AssistantService,
    );

    await service.reconcileStaleTurns("test");

    expect(assistant.markFailed).toHaveBeenCalledTimes(2);
    expect(assistant.markFailed).toHaveBeenLastCalledWith(
      secondStaleTurn.id,
      secondStaleTurn.attempt,
      "generation_failed",
      "The assistant turn was interrupted before completion.",
    );
  });
});
