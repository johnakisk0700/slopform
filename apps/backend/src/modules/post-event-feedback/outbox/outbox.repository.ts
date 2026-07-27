import { Injectable } from "@nestjs/common";
import {
  events,
  feedbackCampaigns,
  messageOutbox,
  type AppTransaction,
  type FeedbackCampaignStatus,
  type MessageOutboxDeliveryStatus,
  type MessageOutboxKind,
  type MessageOutboxRow,
  type MessageOutboxStatus,
} from "@join-the-six/database";
import { and, asc, count, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";

/** Stale `sending` rows older than this are reclaimed for re-enqueue / reconcile. */
export const FEEDBACK_OUTBOX_RECOVERY_MS = 5 * 60_000;
export const FEEDBACK_OUTBOX_BATCH_SIZE = 50;

/**
 * The statuses that mean "written down, but the participant does not have it".
 *
 * `sent`, `failed` and `cancelled` are all terminal — nobody is waiting on
 * them any more — so the observability read model is exactly these three.
 * `held` and `pending` are both parked rather than moving; only `sending` has
 * been handed to the relay.
 */
export const FEEDBACK_OUTBOX_UNDELIVERED_STATUSES = [
  "pending",
  "sending",
  "held",
] as const satisfies readonly MessageOutboxStatus[];

export type FeedbackUndeliveredOutboxStatus =
  (typeof FEEDBACK_OUTBOX_UNDELIVERED_STATUSES)[number];

/**
 * One undelivered outbox row with the campaign context that decides whether it
 * is stuck or deliberately parked: the relay skips any row whose campaign is
 * not `launched`, so `campaignStatus` is what separates "the system is behind"
 * from "an operator pressed pause".
 */
export interface FeedbackUndeliveredOutboxRow {
  readonly row: MessageOutboxRow;
  readonly campaignStatus: FeedbackCampaignStatus;
  readonly eventId: string;
  readonly eventTitle: string;
}

/** Upper bound on one page of the undelivered list. */
export const FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT = 200;

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackOutboxRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
  ) {}

  /**
   * Enqueues an outbound message. Duplicate `dedupe_key` inserts are ignored
   * and the existing row is returned.
   */
  async insertOutboxIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly campaignId: string;
      readonly kind: MessageOutboxKind;
      readonly body: string;
      readonly dedupeKey: string;
      readonly status?: MessageOutboxStatus;
      readonly createdByStaff?: string | null;
    },
  ): Promise<{ readonly row: MessageOutboxRow; readonly inserted: boolean }> {
    const [inserted] = await transaction
      .insert(messageOutbox)
      .values({
        conversationId: input.conversationId,
        campaignId: input.campaignId,
        kind: input.kind,
        body: input.body,
        dedupeKey: input.dedupeKey,
        status: input.status ?? "pending",
        createdByStaff: input.createdByStaff ?? null,
      })
      .onConflictDoNothing({
        target: [messageOutbox.dedupeKey],
      })
      .returning();

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.findOutboxByDedupeKey(
      input.dedupeKey,
      transaction,
    );

    if (!existing) {
      throw new Error(
        "Message outbox conflict did not resolve to an existing row",
      );
    }

    return { row: existing, inserted: false };
  }

  async findOutboxById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.id, id))
      .limit(1);

    return record;
  }

  async findOutboxByDedupeKey(
    dedupeKey: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.dedupeKey, dedupeKey))
      .limit(1);

    return record;
  }

  async findOutboxByProviderMessageId(
    providerMessageId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.providerMessageId, providerMessageId))
      .limit(1);

    return record;
  }

  /**
   * Correlates an observed outbound message that carries no provider message id
   * yet: the oldest not-yet-linked row of that conversation with the exact same
   * body. Cancelled and held rows are excluded because they were never sent.
   */
  async findUnlinkedOutboxByConversationAndBody(
    conversationId: string,
    body: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          eq(messageOutbox.body, body),
          isNull(messageOutbox.providerMessageId),
          inArray(messageOutbox.status, ["pending", "sending", "sent"]),
        ),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(1);

    return record;
  }

  async listOutboxByConversation(
    conversationId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow[]> {
    return executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.conversationId, conversationId))
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id));
  }

  async updateOutboxStatus(
    transaction: AppTransaction,
    id: string,
    status: MessageOutboxStatus,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await transaction
      .update(messageOutbox)
      .set({ status, updatedAt: new Date() })
      .where(eq(messageOutbox.id, id))
      .returning();

    return record;
  }

  async updateOutboxDelivery(
    transaction: AppTransaction,
    id: string,
    input: {
      readonly deliveryStatus: MessageOutboxDeliveryStatus;
      readonly providerLogId?: string | null;
      readonly providerMessageId?: string | null;
      readonly sentAt?: Date | null;
      readonly deliveredAt?: Date | null;
      readonly readAt?: Date | null;
      readonly playedAt?: Date | null;
      readonly status?: MessageOutboxStatus;
    },
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await transaction
      .update(messageOutbox)
      .set({
        deliveryStatus: input.deliveryStatus,
        deliveryUpdatedAt: new Date(),
        updatedAt: new Date(),
        ...(input.providerLogId !== undefined
          ? { providerLogId: input.providerLogId }
          : {}),
        ...(input.providerMessageId !== undefined
          ? { providerMessageId: input.providerMessageId }
          : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
        ...(input.deliveredAt !== undefined
          ? { deliveredAt: input.deliveredAt }
          : {}),
        ...(input.readAt !== undefined ? { readAt: input.readAt } : {}),
        ...(input.playedAt !== undefined ? { playedAt: input.playedAt } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      })
      .where(eq(messageOutbox.id, id))
      .returning();

    return record;
  }

  async cancelQueuedOutboxForConversation(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          inArray(messageOutbox.status, ["pending", "held"]),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  async cancelQueuedOutboxForCampaign(
    transaction: AppTransaction,
    campaignId: string,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(messageOutbox.campaignId, campaignId),
          inArray(messageOutbox.status, ["pending", "held"]),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /**
   * The undelivered queue, oldest first, for the operator observability screen.
   *
   * Oldest first because age is the question the screen exists to answer, and
   * `message_outbox_status_created_idx` is `(status, created_at)`, so the order
   * is the index's own. One statement, no Redis and no per-row work: the
   * campaign and its event title come along on the join rather than through a
   * lookup the caller would repeat 200 times.
   */
  async listUndeliveredOutbox(
    limit = FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackUndeliveredOutboxRow[]> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
    );
    const rows = await executor
      .select({
        row: messageOutbox,
        campaignStatus: feedbackCampaigns.status,
        eventId: feedbackCampaigns.eventId,
        eventTitle: events.title,
      })
      .from(messageOutbox)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackCampaigns.id, messageOutbox.campaignId),
      )
      .innerJoin(events, eq(events.id, feedbackCampaigns.eventId))
      .where(
        inArray(messageOutbox.status, [
          ...FEEDBACK_OUTBOX_UNDELIVERED_STATUSES,
        ]),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(boundedLimit);

    return rows.map((entry) => ({
      row: entry.row,
      campaignStatus: entry.campaignStatus as FeedbackCampaignStatus,
      eventId: entry.eventId,
      eventTitle: entry.eventTitle,
    }));
  }

  /**
   * Undelivered totals per status, so a capped list never implies the cap is
   * the whole backlog.
   */
  async countUndeliveredOutboxByStatus(
    executor: DatabaseExecutor = this.database.db,
  ): Promise<Map<FeedbackUndeliveredOutboxStatus, number>> {
    const rows = await executor
      .select({ status: messageOutbox.status, total: count() })
      .from(messageOutbox)
      .where(
        inArray(messageOutbox.status, [
          ...FEEDBACK_OUTBOX_UNDELIVERED_STATUSES,
        ]),
      )
      .groupBy(messageOutbox.status);

    const totals = new Map<FeedbackUndeliveredOutboxStatus, number>(
      FEEDBACK_OUTBOX_UNDELIVERED_STATUSES.map((status) => [status, 0]),
    );
    for (const row of rows) {
      const status = FEEDBACK_OUTBOX_UNDELIVERED_STATUSES.find(
        (candidate) => candidate === row.status,
      );
      if (status) {
        totals.set(status, Number(row.total));
      }
    }
    return totals;
  }

  /** Lists due outbox rows without locking. Prefer `claimOutboxBatch` for relay. */
  async listDueOutbox(
    statuses: readonly MessageOutboxStatus[] = ["pending"],
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow[]> {
    return executor
      .select()
      .from(messageOutbox)
      .where(inArray(messageOutbox.status, [...statuses]))
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(limit);
  }

  /**
   * Leases due outbox rows with `FOR UPDATE SKIP LOCKED`. `held` rows are never
   * selected. Rows whose campaign is not `launched` (paused/closed kill switch)
   * stay pending so resume can lease them later. Stale `sending` rows past the
   * recovery horizon are reclaimed so a lost BullMQ job can be republished; the
   * deliver consumer reconciles before ever calling send again.
   */
  async claimOutboxBatch(
    now: Date,
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
    recoveryMs = FEEDBACK_OUTBOX_RECOVERY_MS,
  ): Promise<MessageOutboxRow[]> {
    return this.database.transaction(async (transaction) => {
      const recoveryBefore = new Date(now.getTime() - recoveryMs);
      const candidates = await transaction
        .select()
        .from(messageOutbox)
        .where(
          or(
            eq(messageOutbox.status, "pending"),
            and(
              eq(messageOutbox.status, "sending"),
              lte(messageOutbox.updatedAt, recoveryBefore),
            ),
          ),
        )
        .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
        .limit(limit)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) {
        return [];
      }

      const claimable: MessageOutboxRow[] = [];
      for (const candidate of candidates) {
        const campaign = await this.campaigns.findCampaignById(
          candidate.campaignId,
          transaction,
        );
        if (campaign?.status === "launched") {
          claimable.push(candidate);
        }
      }

      if (claimable.length === 0) {
        return [];
      }

      return transaction
        .update(messageOutbox)
        .set({ status: "sending", updatedAt: now })
        .where(
          inArray(
            messageOutbox.id,
            claimable.map((candidate) => candidate.id),
          ),
        )
        .returning();
    });
  }

  /**
   * Returns a leased row to `pending` after a failed enqueue, but only when no
   * provider attempt has been recorded. An unknown-outcome attempt stays in
   * `sending` so recovery reconciles instead of releasing it for a blind retry.
   */
  async releaseOutboxLease(
    id: string,
    now = new Date(),
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await this.database.db
      .update(messageOutbox)
      .set({ status: "pending", updatedAt: now })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "sending"),
          isNull(messageOutbox.deliveryStatus),
          isNull(messageOutbox.providerLogId),
          isNull(messageOutbox.providerMessageId),
        ),
      )
      .returning();

    return record;
  }

  async findOutboxByProviderLogId(
    providerLogId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.providerLogId, providerLogId))
      .limit(1);

    return record;
  }
}
