import { Injectable } from "@nestjs/common";
import {
  feedbackSimOutbound,
  type AppTransaction,
  type FeedbackSimOutboundRow,
} from "@join-the-six/database";
import { asc, eq } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackSimOutboundRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Dev-only simulated transport sink (WP8). */
  async insertSimOutbound(
    input: {
      readonly id?: string;
      readonly outboxId: string;
      readonly phoneE164: string;
      readonly body: string;
      readonly providerMessageId: string;
      readonly sentAt: Date;
    },
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackSimOutboundRow> {
    const [record] = await executor
      .insert(feedbackSimOutbound)
      .values({
        id: input.id,
        outboxId: input.outboxId,
        phoneE164: input.phoneE164,
        body: input.body,
        providerMessageId: input.providerMessageId,
        sentAt: input.sentAt,
      })
      .returning();

    if (!record) {
      throw new Error("Simulated outbound insert returned no row");
    }

    return record;
  }

  async listSimOutboundByPhoneE164(
    phoneE164: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<readonly FeedbackSimOutboundRow[]> {
    return executor
      .select()
      .from(feedbackSimOutbound)
      .where(eq(feedbackSimOutbound.phoneE164, phoneE164))
      .orderBy(asc(feedbackSimOutbound.sentAt), asc(feedbackSimOutbound.id));
  }

  async findSimOutboundById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackSimOutboundRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackSimOutbound)
      .where(eq(feedbackSimOutbound.id, id))
      .limit(1);

    return record;
  }
}
