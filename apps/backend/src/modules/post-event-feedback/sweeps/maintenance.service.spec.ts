import { describe, expect, it, vi } from "vitest";

import {
  FeedbackMaintenanceError,
  PostEventFeedbackMaintenanceService,
} from "./maintenance.service.js";
import type { PostEventFeedbackSweepService } from "./sweep.service.js";
import type { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import type { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";
import type { FeedbackCampaignResumeRepairService } from "../campaign/resume-repair.service.js";

describe("PostEventFeedbackMaintenanceService", () => {
  it("runs every bounded repair even when a sibling repair fails", async () => {
    const { service, sweeps, campaignResumes, conversations, summaries } =
      createService();
    conversations.recoverDue.mockRejectedValue(new Error("mongo unavailable"));

    const failure = await service.run("maintenance-1").catch((error) => error);

    expect(failure).toBeInstanceOf(FeedbackMaintenanceError);
    expect(failure.result).toEqual({
      completed: ["ingress", "campaign-resumes", "summaries"],
      failed: ["conversations"],
    });
    expect(sweeps.sweepIngress).toHaveBeenCalledOnce();
    expect(campaignResumes.recover).toHaveBeenCalledOnce();
    expect(conversations.recoverDue).toHaveBeenCalledOnce();
    expect(summaries.recover).toHaveBeenCalledOnce();
  });

  it("reports a complete pass when all durable intents were inspected", async () => {
    const { service } = createService();

    await expect(service.run("maintenance-1")).resolves.toEqual({
      completed: ["ingress", "campaign-resumes", "conversations", "summaries"],
      failed: [],
    });
  });

  it("isolates a failed campaign-resume hand-off from the other repairs", async () => {
    const { service, campaignResumes, conversations, summaries } =
      createService();
    campaignResumes.recover.mockRejectedValue(new Error("mongo unavailable"));

    const failure = await service.run("maintenance-1").catch((error) => error);

    expect(failure).toBeInstanceOf(FeedbackMaintenanceError);
    expect(failure.result).toEqual({
      completed: ["ingress", "conversations", "summaries"],
      failed: ["campaign-resumes"],
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
  const campaignResumes = {
    recover: vi.fn().mockResolvedValue({
      examined: 0,
      applied: 0,
      conversationsMarked: 0,
      wakeupsPublished: 0,
    }),
  };
  const summaries = {
    recover: vi
      .fn()
      .mockResolvedValue({ pending: 0, examined: 0, requested: 0 }),
  };
  return {
    service: new PostEventFeedbackMaintenanceService(
      sweeps as unknown as PostEventFeedbackSweepService,
      campaignResumes as unknown as FeedbackCampaignResumeRepairService,
      conversations as unknown as FeedbackConversationWakeupService,
      summaries as unknown as PostEventFeedbackCampaignSummaryService,
    ),
    sweeps,
    campaignResumes,
    conversations,
    summaries,
  };
}
