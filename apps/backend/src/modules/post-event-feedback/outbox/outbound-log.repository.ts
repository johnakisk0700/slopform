import { Injectable } from "@nestjs/common";
import {
  messageOutboxLog,
  type AppTransaction,
  type MessageOutboxLogOrigin,
  type MessageOutboxLogRow,
} from "@join-the-six/database";
import { eq } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackOutboundDecision } from "./outbound-log.schemas.js";
import type { OutboundConversationSnapshot } from "./outbound-log.snapshot.js";

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackOutboundLogRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Records the decision behind an outbox row. Duplicate `outbox_id` inserts
   * are ignored and the existing row is returned.
   */
  async insertOutboxLogIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly outboxId: string;
      readonly conversationId: string;
      readonly campaignId: string;
      readonly origin: MessageOutboxLogOrigin;
      readonly correlationId: string;
      readonly decision: FeedbackOutboundDecision;
      readonly conversationState: OutboundConversationSnapshot;
    },
  ): Promise<{ readonly row: MessageOutboxLogRow; readonly inserted: boolean }> {
    const [inserted] = await transaction
      .insert(messageOutboxLog)
      .values({
        outboxId: input.outboxId,
        conversationId: input.conversationId,
        campaignId: input.campaignId,
        origin: input.origin,
        correlationId: input.correlationId,
        decision: input.decision,
        conversationState: input.conversationState,
      })
      .onConflictDoNothing({
        target: [messageOutboxLog.outboxId],
      })
      .returning();

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.findLogByOutboxId(input.outboxId, transaction);

    if (!existing) {
      throw new Error(
        "Message outbox log conflict did not resolve to an existing row",
      );
    }

    return { row: existing, inserted: false };
  }

  async findLogByOutboxId(
    outboxId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxLogRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutboxLog)
      .where(eq(messageOutboxLog.outboxId, outboxId))
      .limit(1);

    return record;
  }
}
