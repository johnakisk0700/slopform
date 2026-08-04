import { Injectable, Logger } from "@nestjs/common";

import { PostEventFeedbackSweepService } from "./sweep.service.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";
import { FeedbackCampaignResumeRepairService } from "../campaign/resume-repair.service.js";

export type FeedbackMaintenanceSubtask =
  "ingress" | "campaign-resumes" | "conversations" | "summaries";

export interface FeedbackMaintenanceResult {
  readonly completed: readonly FeedbackMaintenanceSubtask[];
  readonly failed: readonly FeedbackMaintenanceSubtask[];
}

/**
 * One bounded repair pass. Subtasks remain isolated so a broken provider or
 * store cannot prevent unrelated durable intent from being rediscovered.
 */
@Injectable()
export class PostEventFeedbackMaintenanceService {
  private readonly logger = new Logger(
    PostEventFeedbackMaintenanceService.name,
  );

  constructor(
    private readonly sweeps: PostEventFeedbackSweepService,
    private readonly campaignResumes: FeedbackCampaignResumeRepairService,
    private readonly conversations: FeedbackConversationWakeupService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
  ) {}

  async run(correlationId: string): Promise<FeedbackMaintenanceResult> {
    const tasks: readonly [
      FeedbackMaintenanceSubtask,
      () => Promise<unknown>,
    ][] = [
      ["ingress", () => this.sweeps.sweepIngress(correlationId)],
      ["campaign-resumes", () => this.campaignResumes.recover(correlationId)],
      ["conversations", () => this.conversations.recoverDue(correlationId)],
      ["summaries", () => this.summaries.recover(correlationId)],
    ];
    const settled = await Promise.allSettled(
      tasks.map(([, execute]) => execute()),
    );
    const completed: FeedbackMaintenanceSubtask[] = [];
    const failed: FeedbackMaintenanceSubtask[] = [];
    const errors: unknown[] = [];

    settled.forEach((result, index) => {
      const task = tasks[index]?.[0];
      if (!task) return;
      if (result.status === "fulfilled") {
        completed.push(task);
        return;
      }
      failed.push(task);
      errors.push(result.reason);
      this.logger.error({
        event: "feedback.maintenance.subtask_failed",
        correlationId,
        subtask: task,
        error: {
          name:
            result.reason instanceof Error
              ? result.reason.name
              : "UnknownError",
        },
      });
    });

    if (errors.length > 0) {
      throw new FeedbackMaintenanceError({ completed, failed }, errors);
    }
    return { completed, failed };
  }
}

export class FeedbackMaintenanceError extends AggregateError {
  constructor(
    readonly result: FeedbackMaintenanceResult,
    errors: readonly unknown[],
  ) {
    super(errors, "One or more feedback maintenance subtasks failed");
    this.name = FeedbackMaintenanceError.name;
  }
}
