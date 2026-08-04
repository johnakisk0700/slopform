import { Injectable } from "@nestjs/common";
import {
  feedbackMaintenanceCheckpoints,
  type AppTransaction,
  type FeedbackMaintenanceCheckpointRow,
  type FeedbackMaintenanceCheckpointTask,
} from "@join-the-six/database";
import { eq, sql } from "drizzle-orm";

export interface FeedbackConversationRecoveryCursor {
  readonly nextActionAt: Date;
  readonly conversationId: string;
}

export interface FeedbackPendingIngressRecoveryCursor {
  readonly createdAt: Date;
  readonly ingressId: string;
}

export interface FeedbackPendingSummaryRecoveryCursor {
  readonly requestedAt: Date;
  readonly campaignId: string;
}

export interface FeedbackCampaignResumeRecoveryCursor {
  readonly dueAt: Date;
  readonly campaignId: string;
}

const CONVERSATION_DUE_TASK =
  "conversation_due" as const satisfies FeedbackMaintenanceCheckpointTask;
const INGRESS_PENDING_TASK =
  "ingress_pending" as const satisfies FeedbackMaintenanceCheckpointTask;
const SUMMARY_AUTO_TASK =
  "summary_auto" as const satisfies FeedbackMaintenanceCheckpointTask;
const SUMMARY_PENDING_TASK =
  "summary_pending" as const satisfies FeedbackMaintenanceCheckpointTask;
const CAMPAIGN_RESUME_TASK =
  "campaign_resume" as const satisfies FeedbackMaintenanceCheckpointTask;

/**
 * PostgreSQL-owned fairness checkpoints for bounded maintenance scans.
 *
 * The caller owns the transaction and keeps the row lock only while allocating
 * one page. Processing happens after commit. A crashed allocator may therefore
 * skip its page until the finite wrap, but durable Mongo/PostgreSQL intent is
 * never consumed by this cursor and cannot be lost.
 */
@Injectable()
export class FeedbackMaintenanceCheckpointRepository {
  async lockConversationDue(
    transaction: AppTransaction,
  ): Promise<FeedbackConversationRecoveryCursor | undefined> {
    const cursor = await this.lockTimedCursor(
      transaction,
      CONVERSATION_DUE_TASK,
      "Conversation recovery",
    );
    if (!cursor) return undefined;
    return {
      nextActionAt: cursor.cursorAt,
      conversationId: cursor.cursorId,
    };
  }

  async saveConversationDue(
    transaction: AppTransaction,
    cursor: FeedbackConversationRecoveryCursor | undefined,
  ): Promise<void> {
    await this.save(transaction, CONVERSATION_DUE_TASK, {
      cursorAt: cursor?.nextActionAt ?? null,
      cursorId: cursor?.conversationId ?? null,
    });
  }

  async lockPendingIngress(
    transaction: AppTransaction,
  ): Promise<FeedbackPendingIngressRecoveryCursor | undefined> {
    const cursor = await this.lockTimedCursor(
      transaction,
      INGRESS_PENDING_TASK,
      "Pending-ingress",
    );
    if (!cursor) return undefined;
    return {
      createdAt: cursor.cursorAt,
      ingressId: cursor.cursorId,
    };
  }

  async savePendingIngress(
    transaction: AppTransaction,
    cursor: FeedbackPendingIngressRecoveryCursor | undefined,
  ): Promise<void> {
    await this.save(transaction, INGRESS_PENDING_TASK, {
      cursorAt: cursor?.createdAt ?? null,
      cursorId: cursor?.ingressId ?? null,
    });
  }

  async lockPendingSummary(
    transaction: AppTransaction,
  ): Promise<FeedbackPendingSummaryRecoveryCursor | undefined> {
    const cursor = await this.lockTimedCursor(
      transaction,
      SUMMARY_PENDING_TASK,
      "Pending-summary",
    );
    if (!cursor) return undefined;
    return {
      requestedAt: cursor.cursorAt,
      campaignId: cursor.cursorId,
    };
  }

  async savePendingSummary(
    transaction: AppTransaction,
    cursor: FeedbackPendingSummaryRecoveryCursor | undefined,
  ): Promise<void> {
    await this.save(transaction, SUMMARY_PENDING_TASK, {
      cursorAt: cursor?.requestedAt ?? null,
      cursorId: cursor?.campaignId ?? null,
    });
  }

  async lockCampaignResume(
    transaction: AppTransaction,
  ): Promise<FeedbackCampaignResumeRecoveryCursor | undefined> {
    const cursor = await this.lockTimedCursor(
      transaction,
      CAMPAIGN_RESUME_TASK,
      "Campaign-resume",
    );
    if (!cursor) return undefined;
    return {
      dueAt: cursor.cursorAt,
      campaignId: cursor.cursorId,
    };
  }

  async saveCampaignResume(
    transaction: AppTransaction,
    cursor: FeedbackCampaignResumeRecoveryCursor | undefined,
  ): Promise<void> {
    await this.save(transaction, CAMPAIGN_RESUME_TASK, {
      cursorAt: cursor?.dueAt ?? null,
      cursorId: cursor?.campaignId ?? null,
    });
  }

  async lockAutomaticSummary(
    transaction: AppTransaction,
  ): Promise<string | undefined> {
    const row = await this.lock(transaction, SUMMARY_AUTO_TASK);
    if (row.cursorAt !== null) {
      throw new Error("Automatic-summary checkpoint unexpectedly has a date");
    }
    return row.cursorId ?? undefined;
  }

  async saveAutomaticSummary(
    transaction: AppTransaction,
    campaignId: string | undefined,
  ): Promise<void> {
    await this.save(transaction, SUMMARY_AUTO_TASK, {
      cursorAt: null,
      cursorId: campaignId ?? null,
    });
  }

  private async lockTimedCursor(
    transaction: AppTransaction,
    task: FeedbackMaintenanceCheckpointTask,
    label: string,
  ): Promise<
    { readonly cursorAt: Date; readonly cursorId: string } | undefined
  > {
    const row = await this.lock(transaction, task);
    if (row.cursorId === null && row.cursorAt === null) {
      return undefined;
    }
    if (row.cursorId === null || row.cursorAt === null) {
      throw new Error(`${label} checkpoint has a partial cursor`);
    }
    return { cursorAt: row.cursorAt, cursorId: row.cursorId };
  }

  private async lock(
    transaction: AppTransaction,
    task: FeedbackMaintenanceCheckpointTask,
  ): Promise<FeedbackMaintenanceCheckpointRow> {
    await transaction
      .insert(feedbackMaintenanceCheckpoints)
      .values({ task })
      .onConflictDoNothing({ target: feedbackMaintenanceCheckpoints.task });

    const [row] = await transaction
      .select()
      .from(feedbackMaintenanceCheckpoints)
      .where(eq(feedbackMaintenanceCheckpoints.task, task))
      .limit(1)
      .for("update");
    if (!row) {
      throw new Error(`Feedback maintenance checkpoint disappeared: ${task}`);
    }
    return row;
  }

  private async save(
    transaction: AppTransaction,
    task: FeedbackMaintenanceCheckpointTask,
    cursor: Pick<FeedbackMaintenanceCheckpointRow, "cursorAt" | "cursorId">,
  ): Promise<void> {
    const [saved] = await transaction
      .update(feedbackMaintenanceCheckpoints)
      .set({
        ...cursor,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(feedbackMaintenanceCheckpoints.task, task))
      .returning({ task: feedbackMaintenanceCheckpoints.task });
    if (!saved) {
      throw new Error(`Feedback maintenance checkpoint disappeared: ${task}`);
    }
  }
}
