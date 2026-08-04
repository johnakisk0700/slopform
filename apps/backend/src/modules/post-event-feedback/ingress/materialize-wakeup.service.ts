import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";

import { FEEDBACK_INGRESS_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackMaterializeJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";

const LIVE_MATERIALIZE_JOB_STATES = new Set([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children",
]);
const TERMINAL_MATERIALIZE_JOB_STATES = new Set(["completed", "failed"]);

/**
 * Reconciles one durable pending ingress row with its disposable BullMQ
 * wake-up. The stable id suppresses live duplicates, but retained terminal
 * jobs must be removed before BullMQ will accept another execution under the
 * same id.
 */
@Injectable()
export class FeedbackMaterializeWakeupService {
  constructor(
    @InjectQueue(FEEDBACK_INGRESS_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly ingress: FeedbackIngressRepository,
  ) {}

  async ensurePendingQueued(input: {
    readonly ingressId: string;
    readonly correlationId: string;
  }): Promise<string | undefined> {
    if (!(await this.isPending(input.ingressId))) {
      return undefined;
    }

    const jobId = createFeedbackMaterializeJobId(input.ingressId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (LIVE_MATERIALIZE_JOB_STATES.has(state)) {
        return jobId;
      }
      if (TERMINAL_MATERIALIZE_JOB_STATES.has(state)) {
        const removed = await this.removeTerminalJob(existing, jobId);
        if (!removed) {
          return jobId;
        }
      }
    }

    // Materialization may have completed between the first PostgreSQL read and
    // removal of a retained terminal job. Redis cannot make this check atomic,
    // so make the consumer idempotent and avoid the known unnecessary replay.
    if (!(await this.isPending(input.ingressId))) {
      return undefined;
    }

    const data = feedbackMaterializeJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      ingressId: input.ingressId,
      correlationId: input.correlationId,
    });
    const job = await this.queue.add(FEEDBACK_JOB_NAMES.materializeV1, data, {
      jobId,
    });
    if (job.id !== jobId) {
      throw new Error("BullMQ returned an unexpected materialize job id");
    }
    return jobId;
  }

  private async isPending(ingressId: string): Promise<boolean> {
    const row = await this.ingress.findIngressById(ingressId);
    return row?.processingStatus === "pending";
  }

  /**
   * Returns false when another producer replaced the terminal job with a live
   * one. If removal lost a different race, fail loudly: the durable row stays
   * pending and maintenance retries instead of reporting fictional success.
   */
  private async removeTerminalJob(
    existing: Job<FeedbackJobData, void, FeedbackJobName>,
    jobId: string,
  ): Promise<boolean> {
    try {
      await existing.remove();
      return true;
    } catch (error) {
      const current = await this.queue.getJob(jobId);
      if (!current) {
        // Another producer removed it and may die before re-adding it. Take
        // over the add ourselves instead of waiting for the next sweep.
        return true;
      }
      const state = await current.getState();
      if (LIVE_MATERIALIZE_JOB_STATES.has(state)) {
        return false;
      }
      throw error;
    }
  }
}
