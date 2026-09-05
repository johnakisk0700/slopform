import { describe, expect, it, vi } from "vitest";

import {
  FeedbackMaintenanceError,
  PostEventFeedbackMaintenanceService,
} from "./maintenance.service.js";
import type { PostEventFeedbackSweepService } from "./sweep.service.js";
import type { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import type { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";

describe("PostEventFeedbackMaintenanceService", () => {
  it("runs every bounded repair even when a sibling repair fails", async () => {
    const { service, sweeps, conversations, summaries } = createService();
    conversations.recoverDue.mockRejectedValue(new Error("queue unavailable"));

    const failure = await service.run("maintenance-1").catch((error) => error);

    expect(failure).toBeInstanceOf(FeedbackMaintenanceError);
    expect(failure.result).toEqual({
      completed: ["ingress", "summaries"],
      failed: ["conversations"],
    });
    expect(sweeps.sweepIngress).toHaveBeenCalledOnce();
    expect(conversations.recoverDue).toHaveBeenCalledOnce();
    expect(summaries.recover).toHaveBeenCalledOnce();
  });

  it("reports a complete pass when all durable intents were inspected", async () => {
    const { service } = createService();

    await expect(service.run("maintenance-1")).resolves.toEqual({
      completed: ["ingress", "conversations", "summaries"],
      failed: [],
    });
  });

  it("isolates a failed ingress recovery from conversation wake-up republish", async () => {
    const { service, sweeps, conversations, summaries } = createService();
    sweeps.sweepIngress.mockRejectedValue(new Error("ingress scan failed"));

    const failure = await service.run("maintenance-1").catch((error) => error);

    expect(failure).toBeInstanceOf(FeedbackMaintenanceError);
    expect(failure.result).toEqual({
      completed: ["conversations", "summaries"],
      failed: ["ingress"],
    });
    expect(conversations.recoverDue).toHaveBeenCalledOnce();
    expect(summaries.recover).toHaveBeenCalledOnce();
  });
});

function createService() {
  const sweeps = {
    sweepIngress: vi.fn().mockResolvedValue(0),
  };
  const conversations = { recoverDue: vi.fn().mockResolvedValue(0) };
  const summaries = {
    recover: vi
      .fn()
      .mockResolvedValue({ pending: 0, examined: 0, requested: 0 }),
  };
  return {
    service: new PostEventFeedbackMaintenanceService(
      sweeps as unknown as PostEventFeedbackSweepService,
      conversations as unknown as FeedbackConversationWakeupService,
      summaries as unknown as PostEventFeedbackCampaignSummaryService,
    ),
    sweeps,
    conversations,
    summaries,
  };
}
