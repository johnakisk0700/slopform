import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { FEEDBACK_TOPIC_ANALYSIS_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { FeedbackLogger } from "../feedback-operation-log.js";
import {
  TOPIC_ANALYSIS_JOB_NAME,
  topicAnalysisJobId,
} from "./topic-analysis.schemas.js";

@Injectable()
export class TopicAnalysisWakeup {
  private readonly logger = new FeedbackLogger(TopicAnalysisWakeup.name);
  constructor(
    @InjectQueue(FEEDBACK_TOPIC_ANALYSIS_QUEUE) private readonly queue: Queue,
  ) {}

  async publish(analysisId: string): Promise<void> {
    try {
      const data = {
        schemaVersion: 1,
        analysisId,
      };
      const jobId = topicAnalysisJobId(analysisId);
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state !== "completed" && state !== "failed") return;
        await existing.remove();
      }
      await this.queue.add(TOPIC_ANALYSIS_JOB_NAME, data, {
        jobId,
        attempts: 3,
        backoff: { type: "fixed", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: { age: 604_800, count: 1000 },
        stackTraceLimit: 1,
      });
    } catch {
      this.logger.warn({
        event: "feedback.topic_analysis.enqueue_failed",
        analysisId,
      });
    }
  }
}
