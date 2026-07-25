import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { ASSISTANT_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  ASSISTANT_JOB_NAMES,
  ASSISTANT_JOB_SCHEMA_VERSION,
  assistantJobDataSchema,
  createAssistantThreadSchema,
  createAssistantTurnJobId,
  createAssistantTurnSchema,
  type AssistantJobData,
  type AssistantJobName,
  type AssistantThreadView,
  type AssistantTurnView,
  type CreateAssistantThreadInput,
  type CreateAssistantTurnInput,
} from "./assistant.schemas.js";
import { AssistantService } from "./assistant.service.js";

export class AssistantEnqueueError extends Error {
  constructor() {
    super("The assistant turn could not be queued");
    this.name = AssistantEnqueueError.name;
  }
}

@Injectable()
export class AssistantJobsService {
  constructor(
    @InjectQueue(ASSISTANT_QUEUE)
    private readonly queue: Queue<AssistantJobData, void, AssistantJobName>,
    private readonly assistant: AssistantService,
  ) {}

  async createThreadAndEnqueue(
    input: CreateAssistantThreadInput,
    createdBy: string,
    correlationId: string,
  ): Promise<AssistantThreadView> {
    const validated = createAssistantThreadSchema.parse(input);
    const creation = await this.assistant.createThread(validated, createdBy);
    if (creation.enqueueRequired) {
      await this.enqueueOrFail(creation.turn, correlationId);
    }
    return creation.thread;
  }

  async appendTurnAndEnqueue(
    threadId: string,
    input: CreateAssistantTurnInput,
    createdBy: string,
    correlationId: string,
  ): Promise<AssistantTurnView> {
    const validated = createAssistantTurnSchema.parse(input);
    const creation = await this.assistant.appendTurn(
      threadId,
      validated,
      createdBy,
    );
    if (creation.enqueueRequired) {
      await this.enqueueOrFail(creation.turn, correlationId);
    }
    return creation.turn;
  }

  async retryTurnAndEnqueue(
    threadId: string,
    turnId: string,
    createdBy: string,
    correlationId: string,
  ): Promise<AssistantTurnView> {
    const turn = await this.assistant.retryTurn(threadId, turnId, createdBy);
    await this.enqueueOrFail(turn, correlationId);
    return turn;
  }

  private async enqueueOrFail(
    turn: AssistantTurnView,
    correlationId: string,
  ): Promise<void> {
    const data = assistantJobDataSchema.parse({
      schemaVersion: ASSISTANT_JOB_SCHEMA_VERSION,
      turnId: turn.id,
      correlationId,
    });

    try {
      const job = await this.queue.add(
        ASSISTANT_JOB_NAMES.generateTurnV2,
        data,
        { jobId: createAssistantTurnJobId(turn.id, turn.attempt) },
      );
      if (!job.id) {
        throw new Error("BullMQ returned a job without an id");
      }
    } catch {
      await this.assistant.markFailed(
        turn.id,
        turn.attempt,
        "generation_failed",
        "The assistant turn could not be queued.",
      );
      throw new AssistantEnqueueError();
    }
  }
}
