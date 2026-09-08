import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackLogger } from "../feedback-operation-log.js";
import { TopicAnalysisRepository } from "./topic-analysis.repository.js";
import { TopicAnalysisWakeup } from "./topic-analysis.wakeup.js";

@Injectable()
export class TopicAnalysisRecovery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new FeedbackLogger(TopicAnalysisRecovery.name);
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: TopicAnalysisRepository,
    private readonly wakeup: TopicAnalysisWakeup,
  ) {}
  onModuleInit() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
  }
  async recoverDueRuns() {
    const due = await this.database.transaction((transaction) =>
      this.repository.allocateDueWakeups(transaction),
    );
    for (const run of due) await this.wakeup.publish(run.id);
  }
  private tick() {
    if (this.active) return;
    this.active = this.recoverDueRuns()
      .catch(() => {
        this.logger.warn({ event: "feedback.topic_analysis.recovery_failed" });
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
