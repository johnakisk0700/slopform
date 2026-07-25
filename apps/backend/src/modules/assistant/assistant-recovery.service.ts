import { InjectQueue } from "@nestjs/bullmq";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Queue } from "bullmq";

import { ASSISTANT_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  createAssistantTurnJobId,
  type AssistantJobData,
  type AssistantJobName,
} from "./assistant.schemas.js";
import { AssistantService } from "./assistant.service.js";

export const ASSISTANT_STALE_TURN_MS = 15 * 60 * 1_000;
export const ASSISTANT_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
export const ASSISTANT_RECOVERY_BATCH_SIZE = 100;

const LIVE_JOB_STATES = new Set([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children",
]);

@Injectable()
export class AssistantRecoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AssistantRecoveryService.name);
  private interval: NodeJS.Timeout | undefined;
  private pendingRecovery: Promise<void> | undefined;

  constructor(
    @InjectQueue(ASSISTANT_QUEUE)
    private readonly queue: Queue<AssistantJobData, void, AssistantJobName>,
    private readonly assistant: AssistantService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcileStaleTurns("startup");
    this.interval = setInterval(() => {
      this.scheduleRecovery();
    }, ASSISTANT_RECOVERY_INTERVAL_MS);
    this.interval.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.pendingRecovery;
  }

  async reconcileStaleTurns(
    trigger: "startup" | "periodic" | "test",
    now = new Date(),
  ): Promise<void> {
    const staleBefore = new Date(now.getTime() - ASSISTANT_STALE_TURN_MS);

    try {
      const turns = await this.assistant.findStaleNonterminalTurns(
        staleBefore,
        ASSISTANT_RECOVERY_BATCH_SIZE,
      );
      for (const turn of turns) {
        const jobId = createAssistantTurnJobId(turn.id, turn.attempt);
        const job = await this.queue.getJob(jobId);
        const jobState = job ? await job.getState() : "missing";
        if (LIVE_JOB_STATES.has(jobState)) {
          continue;
        }

        let recovered: boolean;
        try {
          recovered = await this.assistant.markFailed(
            turn.id,
            turn.attempt,
            "generation_failed",
            "The assistant turn was interrupted before completion.",
          );
        } catch (error) {
          this.logger.error({
            event: "assistant.turn.recovery_item_failed",
            trigger,
            turnId: turn.id,
            attempt: turn.attempt,
            error: { name: errorName(error) },
          });
          continue;
        }
        if (recovered) {
          this.logger.warn({
            event: "assistant.turn.recovered_stale",
            trigger,
            turnId: turn.id,
            attempt: turn.attempt,
            jobState,
          });
        }
      }
    } catch (error) {
      this.logger.error({
        event: "assistant.turn.recovery_failed",
        trigger,
        error: { name: errorName(error) },
      });
    }
  }

  private scheduleRecovery(): void {
    if (this.pendingRecovery) {
      return;
    }
    const pending = this.reconcileStaleTurns("periodic").finally(() => {
      if (this.pendingRecovery === pending) {
        this.pendingRecovery = undefined;
      }
    });
    this.pendingRecovery = pending;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
