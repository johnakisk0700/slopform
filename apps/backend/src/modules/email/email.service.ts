import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";
import type { AppTransaction } from "@slopform/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  ResendClientError,
  type EmailDeliverySendInput,
} from "../../integrations/resend/resend.client.js";
import {
  EmailRepository,
  type ClaimedEmailDelivery,
  type EmailDeliveryRecord,
} from "./email.repository.js";
import {
  type CreateEmailDeliveryInput,
  type EmailDeliveryListView,
  type EmailDeliveryView,
} from "./email.schemas.js";

const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_DEFAULT_RETRY_DELAY_MS = 60_000;
const EMAIL_MAX_RETRY_DELAY_MS = 15 * 60_000;
const EMAIL_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60_000;

export class EmailDeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`Email delivery ${id} was not found`);
    this.name = EmailDeliveryNotFoundError.name;
  }
}

export class EmailDeliveryConflictError extends Error {
  constructor() {
    super("The request id already belongs to a different email delivery");
    this.name = EmailDeliveryConflictError.name;
  }
}

@Injectable()
export class EmailService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: EmailRepository,
    private readonly audit: AuditRepository,
  ) {}

  async create(
    input: CreateEmailDeliveryInput,
    createdBy: string,
    correlationId: string,
  ): Promise<EmailDeliveryView> {
    const requestFingerprint = fingerprint(input);

    const delivery = await this.database.transaction(async (transaction) => {
      await this.repository.lockRequest(
        transaction,
        createdBy,
        input.requestId,
      );
      const existing = await this.repository.findByRequestForOwner(
        input.requestId,
        createdBy,
        transaction,
      );
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new EmailDeliveryConflictError();
        }
        return existing;
      }

      const created = await this.repository.createWithOutbox(transaction, {
        ...input,
        createdBy,
        requestFingerprint,
        correlationId,
      });
      await this.audit.append(transaction, {
        actorType: "admin",
        actorId: createdBy,
        action: "email_delivery.created",
        entityType: "email_delivery",
        entityId: created.id,
        requestId: correlationId,
        context: { channel: "email", status: "queued" },
      });
      return created;
    });

    const record = await this.repository.findRecordForOwner(
      delivery.id,
      createdBy,
    );
    if (!record) {
      throw new EmailDeliveryNotFoundError(delivery.id);
    }
    return toView(record);
  }

  async get(id: string, createdBy: string): Promise<EmailDeliveryView> {
    const record = await this.repository.findRecordForOwner(id, createdBy);
    if (!record) {
      throw new EmailDeliveryNotFoundError(id);
    }
    return toView(record);
  }

  async list(createdBy: string): Promise<EmailDeliveryListView> {
    const records = await this.repository.listRecordsForOwner(createdBy);
    return { items: records.map(toView) };
  }

  async processWithProvider(
    deliveryId: string,
    outboxEventId: string,
    now: Date,
    leaseUntil: Date,
    sendEmail: (input: EmailDeliverySendInput) => Promise<void>,
  ): Promise<void> {
    // Claim and commit before crossing the provider boundary. The outbox row
    // stays dispatched until this attempt has a durable terminal outcome.
    const claimed = await this.database.transaction((transaction) =>
      this.repository.claimDelivery(
        transaction,
        deliveryId,
        outboxEventId,
        now,
        leaseUntil,
      ),
    );
    if (!claimed) {
      return;
    }

    const retryWindowExpired =
      now.getTime() - claimed.firstAttemptStartedAt.getTime() >=
      EMAIL_IDEMPOTENCY_WINDOW_MS;
    const attemptsExhausted =
      claimed.attempt.attemptNumber > EMAIL_MAX_ATTEMPTS;
    if (retryWindowExpired || attemptsExhausted) {
      await this.recordFailedDelivery(claimed, now);
      return;
    }

    try {
      await sendEmail({
        recipientEmail: claimed.delivery.recipientEmail,
        subject: claimed.delivery.subject,
        textBody: claimed.delivery.textBody,
        // Resend retains this key for 24 hours. The bounded retry window below
        // stays inside that period, so a lost response can be retried safely.
        idempotencyKey: claimed.delivery.id,
      });
    } catch (error) {
      if (!(error instanceof ResendClientError)) {
        throw error;
      }
      await this.recordProviderFailure(claimed, now, error);
      return;
    }

    await this.database.transaction(async (transaction) => {
      const sent = await this.repository.markSent(transaction, claimed, now);
      if (!sent) {
        return;
      }
      await this.audit.append(transaction, {
        actorType: "system",
        action: "email_delivery.sent",
        entityType: "email_delivery",
        entityId: sent.id,
        context: {
          attempt: claimed.attempt.attemptNumber,
          channel: "email",
          status: "sent",
        },
      });
    });
  }

  async processWithoutProvider(
    deliveryId: string,
    outboxEventId: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const claimed = await this.repository.claimDelivery(
        transaction,
        deliveryId,
        outboxEventId,
        now,
        leaseUntil,
      );
      if (!claimed) {
        return;
      }
      const blocked = await this.repository.markBlocked(
        transaction,
        claimed,
        now,
      );
      if (!blocked) {
        return;
      }

      await this.audit.append(transaction, {
        actorType: "system",
        action: "email_delivery.blocked",
        entityType: "email_delivery",
        entityId: blocked.id,
        context: {
          attempt: claimed.attempt.attemptNumber,
          code: "provider_not_configured",
        },
      });
    });
  }

  private async recordProviderFailure(
    claimed: ClaimedEmailDelivery,
    now: Date,
    error: ResendClientError,
  ): Promise<void> {
    const shouldRetry =
      error.retryable && claimed.attempt.attemptNumber < EMAIL_MAX_ATTEMPTS;
    const nextAttemptAt = shouldRetry
      ? new Date(now.getTime() + retryDelayMs(error.retryAfterSeconds))
      : undefined;

    if (!nextAttemptAt) {
      await this.recordFailedDelivery(claimed, now);
      return;
    }

    await this.database.transaction(async (transaction) => {
      const retried = await this.repository.markRetryScheduled(
        transaction,
        claimed,
        nextAttemptAt,
        now,
      );
      if (!retried) {
        return;
      }
      await this.audit.append(transaction, {
        actorType: "system",
        action: "email_delivery.retry_scheduled",
        entityType: "email_delivery",
        entityId: retried.id,
        context: {
          attempt: claimed.attempt.attemptNumber,
          channel: "email",
          code: "delivery_failed",
          status: "retry_scheduled",
        },
      });
    });
  }

  private async recordFailedDelivery(
    claimed: ClaimedEmailDelivery,
    now: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction: AppTransaction) => {
      const failed = await this.repository.markFailed(
        transaction,
        claimed,
        now,
      );
      if (!failed) {
        return;
      }
      await this.audit.append(transaction, {
        actorType: "system",
        action: "email_delivery.failed",
        entityType: "email_delivery",
        entityId: failed.id,
        context: {
          attempt: claimed.attempt.attemptNumber,
          channel: "email",
          code: "delivery_failed",
          status: "failed",
        },
      });
    });
  }
}

function retryDelayMs(retryAfterSeconds?: number): number {
  if (retryAfterSeconds === undefined) {
    return EMAIL_DEFAULT_RETRY_DELAY_MS;
  }

  return Math.min(
    EMAIL_MAX_RETRY_DELAY_MS,
    Math.max(1_000, retryAfterSeconds * 1_000),
  );
}

function fingerprint(input: {
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
}): string {
  return createHash("sha256")
    .update(input.recipientEmail)
    .update("\0")
    .update(input.subject)
    .update("\0")
    .update(input.textBody)
    .digest("hex");
}

function toView(record: EmailDeliveryRecord): EmailDeliveryView {
  const { delivery } = record;
  return {
    id: delivery.id,
    requestId: delivery.requestId,
    recipientMasked: maskEmail(delivery.recipientEmail),
    status: delivery.status as EmailDeliveryView["status"],
    attemptCount: delivery.attemptCount,
    lastErrorCode: delivery.lastErrorCode as EmailDeliveryView["lastErrorCode"],
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
    completedAt: delivery.completedAt?.toISOString() ?? null,
    attempts: record.attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      status: attempt.status as EmailDeliveryView["attempts"][number]["status"],
      errorCode:
        attempt.errorCode as EmailDeliveryView["attempts"][number]["errorCode"],
      startedAt: attempt.startedAt.toISOString(),
      completedAt: attempt.completedAt?.toISOString() ?? null,
    })),
  };
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}
