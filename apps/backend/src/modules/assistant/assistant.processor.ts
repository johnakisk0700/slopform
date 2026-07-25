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
} from "./assistant.schemas.js";
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

    try {
      const response = await this.generation.generate({
        model: turn.model as AssistantModel,
        effort: turn.effort as AssistantReasoningEffort,
        messages,
      });
      await this.assistant.markSucceeded(turn.id, attempt, response);
    } catch (error) {
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
