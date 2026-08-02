import { InjectQueue } from "@nestjs/bullmq";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Queue } from "bullmq";

import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  createFeedbackExtractJobId,
  createFeedbackExtractParkedJobId,
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_EXTRACTION_PARK_MAX_MS,
  FEEDBACK_EXTRACTION_PARK_RETRY_MS,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackExtractJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import {
  inspectFeedbackExtractJobs,
  unreadParticipantSeqs,
} from "../inbox/inspect-extract-jobs.js";

export const FEEDBACK_EXTRACTION_RECOVERY_BATCH_SIZE = 50;

export interface FeedbackExtractionRecoveryResult {
  readonly examined: number;
  readonly requeued: number;
  readonly healthy: number;
  readonly intentionallyParked: number;
  readonly failed: number;
}

const VIABLE_JOB_STATES = new Set([
  "active",
  "delayed",
  "waiting",
  "waiting-children",
  "prioritized",
]);

/**
 * Recreates extraction intent from MongoDB when Redis no longer carries it.
 * Mongo says whether testimony is unread; BullMQ only says whether a viable
 * execution currently exists.
 */
@Injectable()
export class FeedbackExtractionRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FeedbackExtractionRecoveryService.name);

  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly conversations: FeedbackConversationRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.recover("feedback-extraction-startup-recovery");
    } catch (error) {
      // The five-minute durable sweep retries this pass. A transient MongoDB or
      // Redis failure must be visible, but it must not turn a healthy worker
      // deploy into an endless restart loop.
      this.logger.error({
        event: "feedback.recovery.extraction_startup_failed",
        error: { name: error instanceof Error ? error.name : "Error" },
      });
    }
  }

  async recover(
    correlationId: string,
    now = new Date(),
  ): Promise<FeedbackExtractionRecoveryResult> {
    const candidates =
      await this.conversations.listOpenBotConversationsWithUnreadParticipantMessages(
        {
          limit: FEEDBACK_EXTRACTION_RECOVERY_BATCH_SIZE,
          parkedAfter: new Date(
            now.getTime() - FEEDBACK_EXTRACTION_PARK_MAX_MS,
          ),
        },
      );
    let requeued = 0;
    let healthy = 0;
    let intentionallyParked = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        const outcome = await this.recoverOne(candidate, correlationId, now);
        if (outcome === "requeued") requeued += 1;
        if (outcome === "healthy") healthy += 1;
        if (outcome === "intentionally_parked") intentionallyParked += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({
          event: "feedback.recovery.extraction_requeue_failed",
          correlationId,
          conversationId: candidate._id,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
    }

    const result = {
      examined: candidates.length,
      requeued,
      healthy,
      intentionallyParked,
      failed,
    };
    this.logger.log({
      event: "feedback.recovery.extraction",
      correlationId,
      ...result,
    });
    return result;
  }

  private async recoverOne(
    candidate: FeedbackConversationDocument,
    correlationId: string,
    now: Date,
  ): Promise<"requeued" | "healthy" | "intentionally_parked"> {
    // Reload after the bounded list query: a close, takeover or successful
    // extraction may have settled the candidate while the sweep was waiting.
    const conversation = await this.conversations.findById(candidate._id);
    if (
      !conversation ||
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot" ||
      conversation.awaitingHuman
    ) {
      return "healthy";
    }

    const unreadSeqs = unreadParticipantSeqs(conversation);
    const latestUnread = unreadSeqs.at(-1);
    if (latestUnread === undefined) {
      return "healthy";
    }
    const parkedRetryIds = this.parkedRetryJobIds(conversation, latestUnread);
    const inspection = await inspectFeedbackExtractJobs(
      this.queue,
      conversation._id,
      unreadSeqs,
      parkedRetryIds,
    );
    if (inspection.active || inspection.pending) {
      return "healthy";
    }

    if (
      conversation.extraction.parkedSince &&
      now.getTime() - conversation.extraction.parkedSince.getTime() >=
        FEEDBACK_EXTRACTION_PARK_MAX_MS
    ) {
      // The six-hour provider-incident ceiling is deliberate. Recovery repairs
      // a lost retry; it must not quietly turn a bounded ladder into forever.
      return "intentionally_parked";
    }

    const parked = conversation.extraction.parkedSince !== null;
    const jobId = parked
      ? createFeedbackExtractParkedJobId(
          conversation._id,
          latestUnread,
          conversation.extraction.parkedRuns,
        )
      : createFeedbackExtractJobId(conversation._id, latestUnread);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (VIABLE_JOB_STATES.has(state)) {
        return "healthy";
      }
      await existing.remove();
    }

    const data = feedbackExtractJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      conversationId: conversation._id,
      correlationId: recoveryCorrelationId(correlationId, conversation._id),
    });
    const delay = parked
      ? FEEDBACK_EXTRACTION_PARK_RETRY_MS
      : remainingQuietWindow(conversation, now);
    await this.queue.add(FEEDBACK_JOB_NAMES.extractV1, data, {
      jobId,
      delay,
      ...(parked
        ? {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          }
        : {
            attempts: 5,
            backoff: { type: "exponential" as const, delay: 1_000 },
            removeOnComplete: { age: 86_400, count: 1_000 },
            removeOnFail: { age: 604_800, count: 5_000 },
          }),
      stackTraceLimit: 10,
    });
    return "requeued";
  }

  private parkedRetryJobIds(
    conversation: FeedbackConversationDocument,
    latestUnread: number,
  ): readonly string[] {
    if (conversation.extraction.parkedSince === null) {
      return [];
    }
    return [
      createFeedbackExtractParkedJobId(
        conversation._id,
        latestUnread,
        conversation.extraction.parkedRuns,
      ),
    ];
  }
}

function remainingQuietWindow(
  conversation: FeedbackConversationDocument,
  now: Date,
): number {
  const lastParticipantAt = latestParticipantMessage(conversation)?.at;
  const silenceMs = lastParticipantAt
    ? Math.max(0, now.getTime() - lastParticipantAt.getTime())
    : FEEDBACK_EXTRACT_QUIET_WINDOW_MS;
  return Math.max(
    0,
    FEEDBACK_EXTRACT_QUIET_WINDOW_MS -
      Math.min(silenceMs, FEEDBACK_EXTRACT_QUIET_WINDOW_MS),
  );
}

function recoveryCorrelationId(
  correlationId: string,
  conversationId: string,
): string {
  return `${correlationId.slice(0, 80)}-${conversationId}`;
}
