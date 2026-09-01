import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  emailDeliveries,
  emailDeliveryAttempts,
  emailOutboxEvents,
  type AppDatabase,
  type AppTransaction,
  type EmailDeliveryAttemptRow,
  type EmailDeliveryRow,
  type EmailOutboxEventRow,
} from "@slopform/database";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

type DatabaseExecutor = AppDatabase | AppTransaction;

export interface EmailDeliveryRecord {
  readonly delivery: EmailDeliveryRow;
  readonly attempts: EmailDeliveryAttemptRow[];
}

export interface ClaimedEmailDelivery {
  readonly delivery: EmailDeliveryRow;
  readonly attempt: EmailDeliveryAttemptRow;
}

@Injectable()
export class EmailRepository {
  constructor(private readonly database: DatabaseService) {}

  lockRequest(
    transaction: AppTransaction,
    createdBy: string,
    requestId: string,
  ): Promise<unknown> {
    return transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`email-request:${createdBy}:${requestId}`}, 0))`,
    );
  }

  async findByRequestForOwner(
    requestId: string,
    createdBy: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<EmailDeliveryRow | undefined> {
    const [delivery] = await executor
      .select()
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.requestId, requestId),
          eq(emailDeliveries.createdBy, createdBy),
        ),
      )
      .limit(1);
    return delivery;
  }

  async createWithOutbox(
    transaction: AppTransaction,
    input: {
      readonly createdBy: string;
      readonly requestId: string;
      readonly requestFingerprint: string;
      readonly recipientEmail: string;
      readonly subject: string;
      readonly textBody: string;
      readonly correlationId: string;
    },
  ): Promise<EmailDeliveryRow> {
    const [delivery] = await transaction
      .insert(emailDeliveries)
      .values({
        createdBy: input.createdBy,
        requestId: input.requestId,
        requestFingerprint: input.requestFingerprint,
        recipientEmail: input.recipientEmail,
        subject: input.subject,
        textBody: input.textBody,
      })
      .returning();
    if (!delivery) {
      throw new Error("Email delivery insert returned no row");
    }

    await transaction.insert(emailOutboxEvents).values({
      deliveryId: delivery.id,
      correlationId: input.correlationId,
    });
    return delivery;
  }

  async findRecordForOwner(
    id: string,
    createdBy: string,
  ): Promise<EmailDeliveryRecord | undefined> {
    const [delivery] = await this.database.db
      .select()
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.id, id),
          eq(emailDeliveries.createdBy, createdBy),
        ),
      )
      .limit(1);
    if (!delivery) {
      return undefined;
    }

    const attempts = await this.database.db
      .select()
      .from(emailDeliveryAttempts)
      .where(eq(emailDeliveryAttempts.deliveryId, delivery.id))
      .orderBy(asc(emailDeliveryAttempts.attemptNumber));
    return { delivery, attempts };
  }

  async listRecordsForOwner(createdBy: string): Promise<EmailDeliveryRecord[]> {
    const deliveries = await this.database.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.createdBy, createdBy))
      .orderBy(desc(emailDeliveries.createdAt))
      .limit(50);
    if (deliveries.length === 0) {
      return [];
    }

    const deliveryIds = deliveries.map((delivery) => delivery.id);
    const attempts = await this.database.db
      .select()
      .from(emailDeliveryAttempts)
      .where(inArray(emailDeliveryAttempts.deliveryId, deliveryIds))
      .orderBy(asc(emailDeliveryAttempts.attemptNumber));
    return deliveries.map((delivery) => ({
      delivery,
      attempts: attempts.filter(
        (attempt) => attempt.deliveryId === delivery.id,
      ),
    }));
  }

  async claimOutboxBatch(
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<EmailOutboxEventRow[]> {
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(emailOutboxEvents)
        .where(
          or(
            and(
              eq(emailOutboxEvents.status, "pending"),
              lte(emailOutboxEvents.availableAt, now),
            ),
            and(
              eq(emailOutboxEvents.status, "publishing"),
              lte(emailOutboxEvents.leaseUntil, now),
            ),
            and(
              eq(emailOutboxEvents.status, "dispatched"),
              lte(emailOutboxEvents.availableAt, now),
            ),
          ),
        )
        .orderBy(asc(emailOutboxEvents.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) {
        return [];
      }

      const leaseToken = randomUUID();
      return transaction
        .update(emailOutboxEvents)
        .set({
          status: "publishing",
          leaseToken,
          leaseUntil,
          dispatchedAt: null,
          lastErrorCode: null,
          publishAttempts: sql`${emailOutboxEvents.publishAttempts} + 1`,
          updatedAt: now,
        })
        .where(
          inArray(
            emailOutboxEvents.id,
            candidates.map((candidate) => candidate.id),
          ),
        )
        .returning();
    });
  }

  async markOutboxDispatched(
    event: EmailOutboxEventRow,
    dispatchedAt: Date,
    recoveryAt: Date,
  ): Promise<void> {
    await this.database.db
      .update(emailOutboxEvents)
      .set({
        status: "dispatched",
        availableAt: recoveryAt,
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: null,
        dispatchedAt,
        updatedAt: dispatchedAt,
      })
      .where(
        and(
          eq(emailOutboxEvents.id, event.id),
          eq(emailOutboxEvents.status, "publishing"),
          eq(emailOutboxEvents.leaseToken, event.leaseToken!),
        ),
      );
  }

  async releaseOutbox(
    event: EmailOutboxEventRow,
    availableAt: Date,
    errorCode: "queue_unavailable",
  ): Promise<void> {
    const now = new Date();
    await this.database.db
      .update(emailOutboxEvents)
      .set({
        status: "pending",
        availableAt,
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: errorCode,
        dispatchedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(emailOutboxEvents.id, event.id),
          eq(emailOutboxEvents.status, "publishing"),
          eq(emailOutboxEvents.leaseToken, event.leaseToken!),
        ),
      );
  }

  async claimDelivery(
    transaction: AppTransaction,
    deliveryId: string,
    outboxEventId: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<ClaimedEmailDelivery | undefined> {
    const [outbox] = await transaction
      .select()
      .from(emailOutboxEvents)
      .where(
        and(
          eq(emailOutboxEvents.id, outboxEventId),
          eq(emailOutboxEvents.deliveryId, deliveryId),
        ),
      )
      .limit(1)
      .for("update");
    if (!outbox || outbox.status === "consumed") {
      return undefined;
    }

    const [delivery] = await transaction
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, deliveryId))
      .limit(1)
      .for("update");
    if (!delivery) {
      return undefined;
    }

    const canClaim =
      delivery.status === "queued" ||
      (delivery.status === "retry_scheduled" &&
        delivery.nextAttemptAt !== null &&
        delivery.nextAttemptAt <= now) ||
      (delivery.status === "processing" &&
        delivery.leaseUntil !== null &&
        delivery.leaseUntil <= now);
    if (!canClaim) {
      if (
        delivery.status === "blocked" ||
        delivery.status === "sent" ||
        delivery.status === "failed"
      ) {
        await consumeOutbox(transaction, outboxEventId, now);
      }
      return undefined;
    }

    if (delivery.status === "processing") {
      await transaction
        .update(emailDeliveryAttempts)
        .set({
          status: "unknown",
          errorCode: "lease_expired",
          completedAt: now,
        })
        .where(
          and(
            eq(emailDeliveryAttempts.deliveryId, delivery.id),
            eq(emailDeliveryAttempts.attemptNumber, delivery.attemptCount),
            eq(emailDeliveryAttempts.status, "processing"),
          ),
        );
    }

    const attemptNumber = delivery.attemptCount + 1;
    const leaseToken = randomUUID();
    const [claimed] = await transaction
      .update(emailDeliveries)
      .set({
        status: "processing",
        attemptCount: attemptNumber,
        leaseToken,
        leaseUntil,
        nextAttemptAt: null,
        lastErrorCode: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(emailDeliveries.id, delivery.id))
      .returning();
    if (!claimed) {
      throw new Error("Email delivery claim returned no row");
    }

    const [attempt] = await transaction
      .insert(emailDeliveryAttempts)
      .values({
        deliveryId: delivery.id,
        attemptNumber,
        startedAt: now,
      })
      .returning();
    if (!attempt) {
      throw new Error("Email delivery attempt insert returned no row");
    }

    await consumeOutbox(transaction, outboxEventId, now);
    return { delivery: claimed, attempt };
  }

  async markBlocked(
    transaction: AppTransaction,
    claimed: ClaimedEmailDelivery,
    now: Date,
  ): Promise<EmailDeliveryRow | undefined> {
    const [delivery] = await transaction
      .update(emailDeliveries)
      .set({
        status: "blocked",
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: "provider_not_configured",
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(emailDeliveries.id, claimed.delivery.id),
          eq(emailDeliveries.status, "processing"),
          eq(emailDeliveries.attemptCount, claimed.attempt.attemptNumber),
          eq(emailDeliveries.leaseToken, claimed.delivery.leaseToken!),
        ),
      )
      .returning();
    if (!delivery) {
      return undefined;
    }

    await transaction
      .update(emailDeliveryAttempts)
      .set({
        status: "blocked",
        errorCode: "provider_not_configured",
        completedAt: now,
      })
      .where(
        and(
          eq(emailDeliveryAttempts.deliveryId, delivery.id),
          eq(
            emailDeliveryAttempts.attemptNumber,
            claimed.attempt.attemptNumber,
          ),
          eq(emailDeliveryAttempts.status, "processing"),
        ),
      );
    return delivery;
  }
}

async function consumeOutbox(
  transaction: AppTransaction,
  outboxEventId: string,
  now: Date,
): Promise<void> {
  await transaction
    .update(emailOutboxEvents)
    .set({
      status: "consumed",
      leaseToken: null,
      leaseUntil: null,
      dispatchedAt: sql`coalesce(${emailOutboxEvents.dispatchedAt}, ${now})`,
      consumedAt: now,
      updatedAt: now,
    })
    .where(eq(emailOutboxEvents.id, outboxEventId));
}
