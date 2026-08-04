import { randomUUID } from "node:crypto";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FEEDBACK_CONVERSATION_MAX_MESSAGES } from "../post-event-feedback-conversation.document.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";

describe("FeedbackOutboxRepository prompt context projection", () => {
  it("loads at most one transcript-sized set of statuses in one query", async () => {
    const ids = Array.from(
      { length: FEEDBACK_CONVERSATION_MAX_MESSAGES + 1 },
      () => randomUUID(),
    );
    const projection = [{ outboxId: ids[0]!, status: "sent" as const }];
    const where = vi.fn().mockResolvedValue(projection);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new FeedbackOutboxRepository(
      { db: { select } } as unknown as DatabaseService,
      {} as FeedbackCampaignRepository,
    );

    await expect(repository.listOutboxStatusesByIds(ids)).resolves.toEqual(
      projection,
    );

    expect(select).toHaveBeenCalledTimes(1);
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.params).toEqual(
      ids.slice(0, FEEDBACK_CONVERSATION_MAX_MESSAGES),
    );
  });

  it("does not query PostgreSQL for a transcript with no outbox ids", async () => {
    const select = vi.fn();
    const repository = new FeedbackOutboxRepository(
      { db: { select } } as unknown as DatabaseService,
      {} as FeedbackCampaignRepository,
    );

    await expect(repository.listOutboxStatusesByIds([])).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
