import { Processor, WorkerHost } from "@nestjs/bullmq";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import {
  FEEDBACK_TOPIC_ANALYSIS_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../../infrastructure/queue/queue.constants.js";
import {
  TOPIC_ANALYSIS_JOB_NAME,
  TopicAnalysisFailure,
  topicAnalysisJobId,
  topicAnalysisJobSchema,
} from "./topic-analysis.schemas.js";
import { TopicAnalysisRunner } from "./topic-analysis.runner.js";

@Processor(
  { name: FEEDBACK_TOPIC_ANALYSIS_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: 1,
    maxStalledCount: 1,
    name: "feedback-topic-analysis-worker",
  },
)
export class TopicAnalysisProcessor extends WorkerHost {
  constructor(private readonly runner: TopicAnalysisRunner) {
    super();
  }
  async process(job: Job): Promise<void> {
    const parsed = topicAnalysisJobSchema.safeParse(job.data);
    if (
      job.name !== TOPIC_ANALYSIS_JOB_NAME ||
      !parsed.success ||
      job.id !== topicAnalysisJobId(parsed.data.analysisId)
    )
      throw new UnrecoverableError("Invalid topic analysis job");
    try {
      const outcome = await this.runner.run(parsed.data.analysisId);
      if (outcome === "busy") {
        await job.moveToDelayed(Date.now() + 30_000, job.token);
        throw new DelayedError();
      }
    } catch (error) {
      if (error instanceof TopicAnalysisFailure && !error.retryable)
        throw new UnrecoverableError(error.code);
      throw error;
    }
  }
}
