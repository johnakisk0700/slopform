import { Injectable } from "@nestjs/common";
import {
  providerMessageIngress,
  type AppTransaction,
  type ProviderMessageDirection,
  type ProviderMessageIngressRow,
  type ProviderMessageProcessingStatus,
} from "@join-the-six/database";
import { and, asc, eq, isNull, lte, notInArray, or, sql } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";

export const FEEDBACK_SWEEP_BATCH_SIZE = 50;

export interface FeedbackIngressSerializationKey {
  readonly phoneE164: string | null;
  readonly chatJid: string;
}

/**
 * Stable advisory-lock namespace shared by inbound acknowledgement and the
 * extraction commit fence. Changing it would split old and new workers into
 * two lock domains during a rolling deploy.
 */
export const FEEDBACK_INGRESS_PHONE_LOCK_NAMESPACE = "feedback-ingress-phone";
export const FEEDBACK_INGRESS_CHAT_LOCK_NAMESPACE = "feedback-ingress-chat";

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
    // Every observation takes the same routing lock before PostgreSQL assigns
    // `ingressOrder`. That makes the sequence commit-safe FIFO for this route,
    // including outbound takeover evidence and null-phone shared-session rows.
    // Extraction takes the phone lock before it decides whether an ordinary
    // reply may enter the outbox, so a committed inbound cannot be missed.
    if (input.phoneE164) {
      await this.lockInboundPhone(transaction, input.phoneE164);
    } else {
      await this.lockChatJid(transaction, input.chatJid);
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

  lockChatJid(transaction: AppTransaction, chatJid: string): Promise<unknown> {
    return transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${FEEDBACK_INGRESS_CHAT_LOCK_NAMESPACE}:${chatJid}`}, 0))`,
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

  /**
   * Pending rows sharing one conversation-routing identity, in the only order
   * materialization is allowed to append them.
   *
   * Phone is authoritative when the provider supplied it: the partial MongoDB
   * index also routes open conversations by phone. `chatJid` is the fallback
   * for malformed/unmatched traffic so two replicas still cannot race the same
   * shared-session thread. `ingressOrder` is assigned by PostgreSQL at insert;
   * provider observation time is display metadata and may arrive backdated.
   */
  async listPendingIngressForSerializationKey(
    key: FeedbackIngressSerializationKey,
    throughIngressOrder: number,
    limit = FEEDBACK_SWEEP_BATCH_SIZE,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<ProviderMessageIngressRow[]> {
    return executor
      .select()
      .from(providerMessageIngress)
      .where(
        and(
          eq(providerMessageIngress.processingStatus, "pending"),
          lte(providerMessageIngress.ingressOrder, throughIngressOrder),
          key.phoneE164
            ? eq(providerMessageIngress.phoneE164, key.phoneE164)
            : and(
                isNull(providerMessageIngress.phoneE164),
                eq(providerMessageIngress.chatJid, key.chatJid),
              ),
        ),
      )
      .orderBy(asc(providerMessageIngress.ingressOrder))
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
