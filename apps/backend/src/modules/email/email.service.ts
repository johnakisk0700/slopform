import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  EmailRepository,
  type EmailDeliveryRecord,
} from "./email.repository.js";
import {
  createEmailDeliverySchema,
  type CreateEmailDeliveryInput,
  type EmailDeliveryListView,
  type EmailDeliveryView,
} from "./email.schemas.js";

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
    const validated = createEmailDeliverySchema.parse(input);
    const requestFingerprint = fingerprint(validated);

    const delivery = await this.database.transaction(async (transaction) => {
      await this.repository.lockRequest(
        transaction,
        createdBy,
        validated.requestId,
      );
      const existing = await this.repository.findByRequestForOwner(
        validated.requestId,
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
        ...validated,
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
