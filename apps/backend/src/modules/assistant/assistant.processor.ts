import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  ASSISTANT_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../infrastructure/queue/queue.constants.js";
import {
  AssistantGenerationError,
  AssistantGenerationService,
} from "./assistant-generation.service.js";
import {
  ASSISTANT_JOB_NAMES,
  assistantJobDataSchema,
  parseAssistantTurnJobAttempt,
  type AssistantJobData,
  type AssistantJobName,
  type AssistantModel,
  type AssistantReasoningEffort,
  type AssistantServiceTier,
} from "./assistant.schemas.js";
import {
  AssistantStreamRelay,
  type AssistantStreamEvent,
} from "./assistant-stream.relay.js";
import {
  AssistantService,
  AssistantTurnNotFoundError,
} from "./assistant.service.js";

@Processor(
  { name: ASSISTANT_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: 2,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "assistant-worker",
  },
)
export class AssistantProcessor extends WorkerHost {
  private readonly logger = new Logger(AssistantProcessor.name);

  constructor(
    private readonly assistant: AssistantService,
    private readonly generation: AssistantGenerationService,
    private readonly stream: AssistantStreamRelay,
  ) {
    super();
  }

  async process(
    job: Job<AssistantJobData, void, AssistantJobName>,
  ): Promise<void> {
    if (job.name !== ASSISTANT_JOB_NAMES.generateTurnV2) {
      throw new UnrecoverableError(
        `Unsupported assistant job: ${String(job.name)}`,
      );
    }

    let data: AssistantJobData;
    try {
      data = assistantJobDataSchema.parse(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError("Invalid assistant job payload");
      }
      throw error;
    }

    const attempt = parseAssistantTurnJobAttempt(job.id, data.turnId);
    if (!attempt) {
      throw new UnrecoverableError("Invalid assistant job id");
    }

    let execution;
    try {
      execution = await this.assistant.start(data.turnId, attempt);
    } catch (error) {
      if (error instanceof AssistantTurnNotFoundError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    const { turn, messages } = execution;
    if (
      turn.attempt !== attempt ||
      turn.status === "succeeded" ||
      turn.status === "failed" ||
      messages.length === 0
    ) {
      return;
    }

    // One recorder, two streams: the answer and the model's account of reaching
    // it. Reasoning is carried on the same write so a reader never sees thinking
    // that belongs to a different moment than the text beside it.
    let partial = " ";
    let reasoning: string | null = null;
    let toolCalls = [] as Awaited<
      ReturnType<AssistantGenerationService["generateStreaming"]>
    >["toolCalls"];
    const partials = new PartialRecorder((partial) =>
      this.assistant.recordPartial(
        turn.id,
        attempt,
        partial,
        reasoning,
        toolCalls,
      ),
    );
    const live = new LiveStreamRecorder((event) =>
      this.stream.publish(turn.id, attempt, event),
    );
    live.offer({ kind: "reset" });

    try {
      const response = await this.generation.generateStreaming({
        model: turn.model as AssistantModel,
        effort: turn.effort as AssistantReasoningEffort,
        // The persisted tier, never a live preference: a retry must buy exactly
        // what the original attempt bought, or the same turn bills at two rates.
        serviceTier: turn.serviceTier as AssistantServiceTier,
        messages,
        onDelta: (accumulated) => {
          partial = accumulated;
          partials.offer(accumulated);
          live.offer({ kind: "text", accumulated });
        },
        onReasoningDelta: (accumulated) => {
          reasoning = accumulated;
          // Thinking often runs long before a single token of answer appears;
          // offering the current text keeps that phase visible instead of blank.
          partials.offer(partial);
          live.offer({ kind: "reasoning", accumulated });
        },
        onToolActivity: (activity) => {
          toolCalls = [...activity];
          partials.offer(partial);
          live.offer({ kind: "tools", accumulated: JSON.stringify(activity) });
        },
      });
      await partials.settle();
      await live.settle();
      await this.assistant.markSucceeded(turn.id, attempt, response);
      await this.stream.publish(turn.id, attempt, { kind: "done" });
    } catch (error) {
      await partials.settle();
      await live.settle();
      const terminal =
        (error instanceof AssistantGenerationError && !error.retryable) ||
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const code =
        error instanceof AssistantGenerationError
          ? error.code
          : "generation_failed";

      if (terminal) {
        await this.assistant.markFailed(
          turn.id,
          attempt,
          code,
          failureMessage(code),
        );
        await this.stream.publish(turn.id, attempt, { kind: "done" });
      } else {
        await this.assistant.markQueued(turn.id, attempt);
      }

      if (error instanceof AssistantGenerationError && !error.retryable) {
        throw new UnrecoverableError(failureMessage(code));
      }

      throw new AssistantGenerationError(code, true);
    }
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job | undefined,
    error: Error,
    previous: string,
  ): Promise<void> {
    const attempts = job?.opts.attempts ?? 1;
    const attemptsMade = job?.attemptsMade ?? 0;
    const parsedData = assistantJobDataSchema.safeParse(job?.data);
    const willRetry =
      !!job &&
      !(error instanceof UnrecoverableError) &&
      attemptsMade < attempts;

    this.logger.error({
      event: "queue.job.failed",
      queue: ASSISTANT_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      attempts,
      attemptsMade,
      willRetry,
      ...(parsedData.success
        ? { correlationId: parsedData.data.correlationId }
        : {}),
      error: serializeError(error),
    });

    if (
      willRetry ||
      !job ||
      job.name !== ASSISTANT_JOB_NAMES.generateTurnV2 ||
      !parsedData.success
    ) {
      return;
    }

    const attempt = parseAssistantTurnJobAttempt(
      job.id,
      parsedData.data.turnId,
    );
    if (!attempt) {
      return;
    }

    try {
      await this.assistant.markFailed(
        parsedData.data.turnId,
        attempt,
        "generation_failed",
        failureMessage("generation_failed"),
      );
    } catch (reconciliationError) {
      this.logger.error({
        event: "assistant.turn.failure_reconciliation_failed",
        queue: ASSISTANT_QUEUE,
        jobId: job.id,
        turnId: parsedData.data.turnId,
        attempt,
        error: {
          name:
            reconciliationError instanceof Error
              ? reconciliationError.name
              : "UnknownError",
        },
      });
    }
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string, previous: string): void {
    this.logger.warn({
      event: "queue.job.stalled",
      queue: ASSISTANT_QUEUE,
      jobId,
      previous,
    });
  }

  @OnWorkerEvent("lockRenewalFailed")
  onLockRenewalFailed(jobIds: string[]): void {
    this.logger.error({
      event: "queue.worker.lock_renewal_failed",
      queue: ASSISTANT_QUEUE,
      jobIds,
    });
  }

  @OnWorkerEvent("error")
  onError(error: Error): void {
    this.logger.error({
      event: "queue.worker.error",
      queue: ASSISTANT_QUEUE,
      error: serializeError(error),
    });
  }
}

/** How often streamed text may reach the stores, in milliseconds. */
const PARTIAL_WRITE_INTERVAL_MS = 700;
/** Redis/browser frames are smooth at 20 fps without parsing Markdown per token. */
const LIVE_FRAME_INTERVAL_MS = 50;

/**
 * Bounds partial writes by wall-clock instead of token rate: a fast model would
 * otherwise turn one answer into thousands of writes across two stores. Deltas
 * carry the full accumulated prefix, so dropping intermediate ones is lossless —
 * the next write supersedes every delta it skipped. Writes are serialized and
 * their failures swallowed: live text is an accelerator, and losing it must
 * never fail a turn the queue is still accountable for.
 */
class PartialRecorder {
  private pending: string | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private lastWriteAt = 0;

  constructor(private readonly write: (partial: string) => Promise<void>) {}

  offer(accumulated: string): void {
    if (!accumulated) return;
    this.pending = accumulated;

    const now = Date.now();
    if (now - this.lastWriteAt < PARTIAL_WRITE_INTERVAL_MS) return;
    this.lastWriteAt = now;
    this.flush();
  }

  /** Drains the last held delta and waits for every write to finish. */
  async settle(): Promise<void> {
    this.flush();
    await this.inFlight;
  }

  private flush(): void {
    const partial = this.pending;
    if (partial === null) return;
    this.pending = null;
    this.inFlight = this.inFlight.then(() =>
      this.write(partial).catch(() => undefined),
    );
  }
}

/**
 * Coalesces provider chunks into bounded live frames. Each event still carries
 * the accumulated value, so dropping an intermediate frame is lossless.
 */
class LiveStreamRecorder {
  private readonly pending = new Map<
    AssistantStreamEvent["kind"],
    AssistantStreamEvent
  >();
  private inFlight: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lastWriteAt = 0;

  constructor(
    private readonly write: (event: AssistantStreamEvent) => Promise<void>,
  ) {}

  offer(event: AssistantStreamEvent): void {
    if (event.kind === "done") return;
    this.pending.set(event.kind, event);

    const remaining = LIVE_FRAME_INTERVAL_MS - (Date.now() - this.lastWriteAt);
    if (remaining <= 0) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), remaining);
  }

  async settle(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    await this.inFlight;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;

    const events = [...this.pending.values()];
    this.pending.clear();
    this.lastWriteAt = Date.now();
    this.inFlight = this.inFlight.then(async () => {
      for (const event of events) await this.write(event);
    });
  }
}

function failureMessage(code: AssistantGenerationError["code"]): string {
  switch (code) {
    case "provider_unavailable":
      return "The selected assistant provider is unavailable.";
    case "provider_rejected":
      return "The assistant provider rejected the request.";
    case "generation_failed":
      return "The assistant could not generate a response.";
  }
}

function serializeError(error: Error): { readonly name: string } {
  return { name: error.name };
}
