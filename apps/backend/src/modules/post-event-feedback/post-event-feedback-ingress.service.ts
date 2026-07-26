import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";

import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FEEDBACK_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";
import {
  createFeedbackEditedProviderMessageId,
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackMaterializeJobDataSchema,
  observedProviderMessageSchema,
  type FeedbackJobData,
  type FeedbackJobName,
  type ObservedProviderMessage,
} from "./post-event-feedback.schemas.js";

export class PostEventFeedbackEnqueueError extends Error {
  constructor(readonly ingressId: string) {
    super("The observed provider message could not be queued");
    this.name = PostEventFeedbackEnqueueError.name;
  }
}

export interface RecordObservedMessageResult {
  readonly ingressId: string;
  /** False when the provider redelivered a message we already acknowledged. */
  readonly inserted: boolean;
}

/**
 * The durable webhook edge (D8). One observed provider message performs exactly
 * one `provider_message_ingress` INSERT, deduplicated by
 * `(chat_jid, provider_message_id)`, and one deterministic materialize enqueue.
 * Matching, transcripts, STOP handling and delivery correlation all happen in
 * the worker, never in the request.
 */
@Injectable()
export class PostEventFeedbackIngressService {
  private readonly logger = new Logger(PostEventFeedbackIngressService.name);

  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly database: DatabaseService,
    private readonly repository: PostEventFeedbackRepository,
  ) {}

  async recordObservedMessage(
    input: ObservedProviderMessage,
    correlationId: string,
  ): Promise<RecordObservedMessageResult> {
    const observed = observedProviderMessageSchema.parse(input);

    const { row, inserted } = await this.database.transaction((transaction) =>
      this.repository.insertIngressIfAbsent(transaction, {
        providerMessageId: observed.providerMessageId,
        chatJid: observed.chatJid,
        direction: observed.direction,
        phoneE164: observed.phoneE164,
        text: observed.text,
        observedAt: observed.observedAt,
      }),
    );

    // A redelivery still enqueues: the first delivery may have crashed between
    // the committed row and the queue. The deterministic job id suppresses the
    // duplicate while it is in Redis, and materialization is itself idempotent.
    await this.enqueueMaterialize(row.id, correlationId);

    this.logger.log({
      event: "feedback.ingress.recorded",
      correlationId,
      ingressId: row.id,
      direction: row.direction,
      inserted,
    });

    // Same id, different words: an edit, not a duplicate. Handled after the
    // ordinary path so the original acknowledgement is never at risk, and
    // recorded as its own observation rather than overwriting the first — what
    // somebody originally wrote about another participant is not ours to erase
    // just because they thought better of it.
    if (!inserted && observed.text !== null && row.text !== observed.text) {
      return this.recordEditedRedelivery(observed, correlationId);
    }

    return { ingressId: row.id, inserted };
  }

  private async recordEditedRedelivery(
    observed: ObservedProviderMessage,
    correlationId: string,
  ): Promise<RecordObservedMessageResult> {
    const editedId = createFeedbackEditedProviderMessageId(
      observed.providerMessageId,
      observed.text ?? "",
    );
    const { row, inserted } = await this.database.transaction((transaction) =>
      this.repository.insertIngressIfAbsent(transaction, {
        providerMessageId: editedId,
        chatJid: observed.chatJid,
        direction: observed.direction,
        phoneE164: observed.phoneE164,
        text: observed.text,
        observedAt: observed.observedAt,
      }),
    );

    await this.enqueueMaterialize(row.id, correlationId);

    this.logger.warn({
      event: "feedback.ingress.edited_redelivery",
      correlationId,
      ingressId: row.id,
      originalProviderMessageId: observed.providerMessageId,
      inserted,
    });

    return { ingressId: row.id, inserted };
  }

  private async enqueueMaterialize(
    ingressId: string,
    correlationId: string,
  ): Promise<void> {
    const data = feedbackMaterializeJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      ingressId,
      correlationId,
    });

    try {
      const job = await this.queue.add(FEEDBACK_JOB_NAMES.materializeV1, data, {
        jobId: createFeedbackMaterializeJobId(ingressId),
      });
      if (!job.id) {
        throw new Error("BullMQ returned a job without an id");
      }
    } catch (error) {
      // The row is already committed, so nothing is lost: it stays `pending`
      // and is replayed by a provider redelivery. Refusing to acknowledge is
      // deliberate — a silent 200 would hide the gap.
      this.logger.error({
        event: "feedback.ingress.enqueue_failed",
        correlationId,
        ingressId,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
      throw new PostEventFeedbackEnqueueError(ingressId);
    }
  }
}
