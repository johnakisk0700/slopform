import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabase, type DatabaseClient } from "@slopform/database";
import { createHash } from "node:crypto";

import type { Environment } from "../../../infrastructure/config/environment.js";
import {
  FEEDBACK_SWEEP_BATCH_SIZE,
  FeedbackIngressRepository,
  type FeedbackIngressSerializationKey,
} from "./ingress.repository.js";
import {
  PostEventFeedbackIngressNotFoundError,
  PostEventFeedbackMaterializer,
  type MaterializeFeedbackIngressInput,
  type MaterializeFeedbackIngressResult,
} from "./materialize.service.js";

const FEEDBACK_MATERIALIZATION_LOCK_PREFIX = "feedback-materialization-v1";
export const FEEDBACK_MATERIALIZATION_LOCK_POOL_MAX = 5;

export interface FeedbackMaterializationLockHost {
  withSessionAdvisoryLock<T>(
    lockName: string,
    work: () => Promise<T>,
  ): Promise<T>;
}

/** Dedicated pool: waiting locks must never consume the pool protected work uses. */
export class PostgresSessionMaterializationLockHost implements FeedbackMaterializationLockHost {
  constructor(private readonly client: DatabaseClient) {}

  async withSessionAdvisoryLock<T>(
    lockName: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const connection = await this.client.pool.connect();
    let acquired = false;
    try {
      await connection.query(
        "select pg_advisory_lock(hashtextextended($1, 0))",
        [lockName],
      );
      acquired = true;
      return await work();
    } finally {
      if (!acquired) {
        connection.release();
      } else {
        try {
          const result = await connection.query<{ unlocked: boolean }>(
            "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
            [lockName],
          );
          if (result.rows[0]?.unlocked !== true) {
            throw new Error("PostgreSQL advisory lock ownership was lost");
          }
          connection.release();
        } catch (error) {
          // Destroying this dedicated session is the fail-closed release path.
          connection.release(error instanceof Error ? error : true);
          throw error;
        }
      }
    }
  }
}

/** Deployment-wide mutex for one phone/chat routing identity. */
export class PostgresFeedbackMaterializationLimiter {
  private readonly localTails = new Map<string, Promise<void>>();

  constructor(private readonly database: FeedbackMaterializationLockHost) {}

  async run<T>(
    key: FeedbackIngressSerializationKey,
    work: () => Promise<T>,
  ): Promise<T> {
    const lockName = materializationLockName(key);
    const previous = this.localTails.get(lockName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.localTails.set(lockName, current);
    await previous;
    try {
      return await this.database.withSessionAdvisoryLock(lockName, work);
    } finally {
      release();
      if (this.localTails.get(lockName) === current) {
        this.localTails.delete(lockName);
      }
    }
  }
}

@Injectable()
export class FeedbackMaterializationLimiter
  extends PostgresFeedbackMaterializationLimiter
  implements OnModuleDestroy
{
  private readonly logger = new Logger(FeedbackMaterializationLimiter.name);
  private readonly client: DatabaseClient;
  private readonly handlePoolError = (error: Error): void => {
    this.logger.error({
      event: "feedback.materialization_lock_pool.error",
      error: { name: error.name },
    });
  };

  constructor(config: ConfigService<Environment, true>) {
    const serviceName = config.get("OTEL_SERVICE_NAME", { infer: true });
    const client = createDatabase({
      applicationName: `${serviceName.slice(0, 40)}-feedback-locks`,
      connectionString: config.get("DATABASE_URL", { infer: true }),
      maxConnections: FEEDBACK_MATERIALIZATION_LOCK_POOL_MAX,
    });
    super(new PostgresSessionMaterializationLockHost(client));
    this.client = client;
    this.client.pool.on("error", this.handlePoolError);
  }

  async onModuleDestroy(): Promise<void> {
    this.client.pool.off("error", this.handlePoolError);
    await this.client.pool.end();
  }
}

/**
 * Serializes one routing identity across replicas, then drains its durable
 * pending rows in database-assigned insert order before handling the job that woke it.
 * Different conversations still materialize in parallel.
 */
@Injectable()
export class PostEventFeedbackMaterializationCoordinator {
  constructor(
    private readonly ingress: FeedbackIngressRepository,
    private readonly materializer: PostEventFeedbackMaterializer,
    private readonly limiter: FeedbackMaterializationLimiter,
  ) {}

  async materialize(
    input: MaterializeFeedbackIngressInput,
  ): Promise<MaterializeFeedbackIngressResult> {
    const target = await this.ingress.findIngressById(input.ingressId);
    if (!target) {
      throw new PostEventFeedbackIngressNotFoundError(input.ingressId);
    }
    const key = {
      phoneE164: target.phoneE164,
      chatJid: target.chatJid,
    } satisfies FeedbackIngressSerializationKey;

    return this.limiter.run(key, async () => {
      const current = await this.ingress.findIngressById(input.ingressId);
      if (!current || current.processingStatus !== "pending") {
        return this.materializer.materialize(input);
      }

      for (;;) {
        const rows = await this.ingress.listPendingIngressForSerializationKey(
          key,
          target.ingressOrder,
          FEEDBACK_SWEEP_BATCH_SIZE,
        );
        if (rows.length === 0) {
          return this.materializer.materialize(input);
        }

        for (const row of rows) {
          const result = await this.materializer.materialize({
            ingressId: row.id,
            correlationId: input.correlationId,
          });
          if (row.id === input.ingressId) {
            return result;
          }
        }
      }
    });
  }
}

function materializationLockName(key: FeedbackIngressSerializationKey): string {
  // Phone numbers and chat ids do not belong in lock diagnostics.
  const identity = key.phoneE164
    ? `phone:${key.phoneE164}`
    : `chat:${key.chatJid}`;
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${FEEDBACK_MATERIALIZATION_LOCK_PREFIX}:${digest}`;
}
