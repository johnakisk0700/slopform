import { Injectable } from "@nestjs/common";
import {
  providerMessageIngress,
  type AppTransaction,
  type ProviderMessageDirection,
  type ProviderMessageIngressRow,
  type ProviderMessageProcessingStatus,
} from "@join-the-six/database";
import { and, asc, eq, lte, notInArray, or, sql } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";

export const FEEDBACK_SWEEP_BATCH_SIZE = 50;

/**
 * Stable advisory-lock namespace shared by inbound acknowledgement and the
 * extraction commit fence. Changing it would split old and new workers into
 * two lock domains during a rolling deploy.
 */
export const FEEDBACK_INGRESS_PHONE_LOCK_NAMESPACE = "feedback-ingress-phone";

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackIngressRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Durable webhook acknowledgement. Duplicate `(chat_jid, provider_message_id)`
   * inserts are ignored and the existing row is returned.
   */
  async insertIngressIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly providerMessageId: string;
      readonly chatJid: string;
      readonly direction: ProviderMessageDirection;
      readonly phoneE164?: string | null;
      readonly text?: string | null;
      readonly observedAt: Date;
      readonly processingStatus?: ProviderMessageProcessingStatus;
      readonly matchedConversationId?: string | null;
    },
  ): Promise<{
    readonly row: ProviderMessageIngressRow;
    readonly inserted: boolean;
  }> {
    // Extraction takes the same transaction-scoped lock immediately before it
    // decides whether an ordinary reply may enter the outbox. An inbound insert
    // that commits first must therefore be visible to that decision; one that
    // starts after extraction owns the lock waits until the older decision is
    // durable. This is per phone, so unrelated conversations never serialize.
    if (input.direction === "inbound" && input.phoneE164) {
      await this.lockInboundPhone(transaction, input.phoneE164);
    }

    const [inserted] = await transaction
      .insert(providerMessageIngress)
      .values({
        providerMessageId: input.providerMessageId,
        chatJid: input.chatJid,
        direction: input.direction,
        phoneE164: input.phoneE164 ?? null,
        text: input.text ?? null,
        observedAt: input.observedAt,
        processingStatus: input.processingStatus ?? "pending",
        matchedConversationId: input.matchedConversationId ?? null,
      })
      .onConflictDoNothing({
        target: [
          providerMessageIngress.chatJid,
          providerMessageIngress.providerMessageId,
        ],
      })
      .returning();

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.findIngressByChatAndProviderMessage(
      transaction,
      input.chatJid,
      input.providerMessageId,
    );

    if (!existing) {
      throw new Error(
        "Provider ingress conflict did not resolve to an existing row",
      );
    }

    return { row: existing, inserted: false };
  }

  lockInboundPhone(
    transaction: AppTransaction,
    phoneE164: string,
  ): Promise<unknown> {
    return transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${FEEDBACK_INGRESS_PHONE_LOCK_NAMESPACE}:${phoneE164}`}, 0))`,
    );
  }

  /**
   * Whether durable participant ingress exists beyond an extraction's MongoDB
   * snapshot. Pending rows have not reached Mongo yet; materialized rows tied
   * to this conversation reached it after the run loaded its document.
   */
  async hasInboundBeyondSnapshot(
    transaction: AppTransaction,
    input: {
      readonly phoneE164: string;
      readonly conversationId: string;
      readonly snapshotIngressIds: readonly string[];
    },
  ): Promise<boolean> {
    const [record] = await transaction
      .select({ id: providerMessageIngress.id })
      .from(providerMessageIngress)
      .where(
        and(
          eq(providerMessageIngress.direction, "inbound"),
          eq(providerMessageIngress.phoneE164, input.phoneE164),
          or(
            eq(providerMessageIngress.processingStatus, "pending"),
            and(
              eq(providerMessageIngress.processingStatus, "materialized"),
              eq(
                providerMessageIngress.matchedConversationId,
                input.conversationId,
              ),
            ),
          ),
          input.snapshotIngressIds.length > 0
            ? notInArray(providerMessageIngress.id, [
                ...input.snapshotIngressIds,
              ])
            : undefined,
        ),
      )
      .limit(1);

    return record !== undefined;
  }

  async findIngressById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await executor
      .select()
      .from(providerMessageIngress)
      .where(eq(providerMessageIngress.id, id))
      .limit(1);

    return record;
  }

  /**
   * Locks the ingress row for the materialization fence. Two concurrent
   * materialize executions serialize here, and the loser observes a terminal
   * `processing_status` instead of repeating the side effects.
   */
  async findIngressByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await transaction
      .select()
      .from(providerMessageIngress)
      .where(eq(providerMessageIngress.id, id))
      .limit(1)
      .for("update");

    return record;
  }

  async findIngressByChatAndProviderMessage(
    executor: DatabaseExecutor,
    chatJid: string,
    providerMessageId: string,
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await executor
      .select()
      .from(providerMessageIngress)
      .where(
        and(
          eq(providerMessageIngress.chatJid, chatJid),
          eq(providerMessageIngress.providerMessageId, providerMessageId),
        ),
      )
      .limit(1);

    return record;
  }

  async updateIngressProcessing(
    transaction: AppTransaction,
    id: string,
    input: {
      readonly processingStatus: ProviderMessageProcessingStatus;
      readonly matchedConversationId?: string | null;
      readonly text?: string | null;
      readonly phoneE164?: string | null;
    },
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await transaction
      .update(providerMessageIngress)
      .set({
        processingStatus: input.processingStatus,
        ...(input.matchedConversationId !== undefined
          ? { matchedConversationId: input.matchedConversationId }
          : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.phoneE164 !== undefined
          ? { phoneE164: input.phoneE164 }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(providerMessageIngress.id, id))
      .returning();

    return record;
  }

  /**
   * Rows left `pending` after a lost materialize enqueue. The recovery sweep
   * re-enqueues under the same stable job id.
   */
  async listPendingIngressOlderThan(
    olderThan: Date,
    limit = FEEDBACK_SWEEP_BATCH_SIZE,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<ProviderMessageIngressRow[]> {
    return executor
      .select()
      .from(providerMessageIngress)
      .where(
        and(
          eq(providerMessageIngress.processingStatus, "pending"),
          lte(providerMessageIngress.createdAt, olderThan),
        ),
      )
      .orderBy(
        asc(providerMessageIngress.createdAt),
        asc(providerMessageIngress.id),
      )
      .limit(limit);
  }

  async listIngressByPhoneE164(
    phoneE164: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<readonly ProviderMessageIngressRow[]> {
    return executor
      .select()
      .from(providerMessageIngress)
      .where(eq(providerMessageIngress.phoneE164, phoneE164))
      .orderBy(
        asc(providerMessageIngress.observedAt),
        asc(providerMessageIngress.id),
      );
  }
}
