import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ProviderMessageIngressRow } from "@slopform/database";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FEEDBACK_SWEEP_BATCH_SIZE,
  FeedbackIngressRepository,
} from "../ingress/ingress.repository.js";
import { FeedbackMaterializeWakeupService } from "../ingress/materialize-wakeup.service.js";
import { FeedbackMaintenanceCheckpointRepository } from "./maintenance-checkpoint.repository.js";

export type FeedbackIngressSweepResult = {
  readonly examined: number;
  readonly requeued: number;
  readonly failed: number;
};

/**
 * Bounded pending-ingress recovery. Every pass reloads authoritative state;
 * nothing claims exactly-once.
 */
@Injectable()
export class PostEventFeedbackSweepService {
  private readonly logger = new Logger(PostEventFeedbackSweepService.name);

  constructor(
    private readonly materializeWakeups: FeedbackMaterializeWakeupService,
    private readonly config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly checkpoints: FeedbackMaintenanceCheckpointRepository,
    private readonly ingress: FeedbackIngressRepository,
  ) {}

  /**
   * Closes WP4's documented gap: `pending` ingress rows whose materialize
   * enqueue was lost are re-enqueued under the stable job id.
   */
  async sweepIngress(
    correlationId: string,
    now = new Date(),
  ): Promise<FeedbackIngressSweepResult> {
    const minutes = this.config.get(
      "FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES",
      {
        infer: true,
      },
    );
    const olderThan = new Date(now.getTime() - minutes * 60_000);
    const rows = await this.allocatePendingIngressRecoveryPage(olderThan);

    let requeued = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const jobId = await this.materializeWakeups.ensurePendingQueued({
          ingressId: row.id,
          correlationId: `${correlationId}:${row.id}`,
        });
        if (jobId) requeued += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({
          event: "feedback.sweep.ingress_requeue_failed",
          correlationId,
          ingressId: row.id,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
    }

    this.logger.log({
      event: "feedback.sweep.ingress",
      correlationId,
      examined: rows.length,
      requeued,
      failed,
    });

    return { examined: rows.length, requeued, failed };
  }

  /**
   * Allocates one globally fair pending-ingress page before Redis publication.
   * PostgreSQL owns both the rows and this cursor, so the row lock and keyset
   * query share one short transaction. Processing starts only after commit: a
   * dead worker skips forward until the finite wrap instead of pinning every
   * replica on the same poisonous prefix.
   */
  private async allocatePendingIngressRecoveryPage(
    olderThan: Date,
  ): Promise<ProviderMessageIngressRow[]> {
    return this.database.transaction(async (transaction) => {
      const after = await this.checkpoints.lockPendingIngress(transaction);
      let rows = await this.ingress.listPendingIngressOlderThan(
        {
          olderThan,
          limit: FEEDBACK_SWEEP_BATCH_SIZE,
          ...(after ? { after } : {}),
        },
        transaction,
      );

      if (rows.length === 0 && after) {
        await this.checkpoints.savePendingIngress(transaction, undefined);
        rows = await this.ingress.listPendingIngressOlderThan(
          { olderThan, limit: FEEDBACK_SWEEP_BATCH_SIZE },
          transaction,
        );
      }
      if (rows.length === 0) {
        return rows;
      }

      const last = rows.at(-1);
      if (!last) {
        throw new Error("Pending-ingress recovery page had no tail");
      }
      await this.checkpoints.savePendingIngress(
        transaction,
        rows.length < FEEDBACK_SWEEP_BATCH_SIZE
          ? undefined
          : { createdAt: last.createdAt, ingressId: last.id },
      );
      return rows;
    });
  }
}
