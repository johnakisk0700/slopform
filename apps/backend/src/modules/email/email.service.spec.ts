import type { AppTransaction, EmailDeliveryRow } from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { EmailRepository } from "./email.repository.js";
import { EmailDeliveryConflictError, EmailService } from "./email.service.js";

const delivery: EmailDeliveryRow = {
  id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  createdBy: "user_owner",
  requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
  requestFingerprint:
    "85f4ca9bb870eb99ee2691d88e1b2d6fd071df0925fb13b8165c2d2b5d6921f8",
  recipientEmail: "person@example.com",
  subject: "Notice",
  textBody: "Body",
  status: "queued",
  attemptCount: 0,
  leaseToken: null,
  leaseUntil: null,
  nextAttemptAt: null,
  lastErrorCode: null,
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
  completedAt: null,
};

describe("EmailService", () => {
  it("creates intent, outbox and redacted audit in one transaction", async () => {
    const transaction = {} as AppTransaction;
    const database = {
      transaction: vi.fn(
        async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
          work(transaction),
      ),
    } as unknown as DatabaseService;
    const repository = {
      lockRequest: vi.fn(),
      findByRequestForOwner: vi.fn().mockResolvedValue(undefined),
      createWithOutbox: vi.fn().mockResolvedValue(delivery),
      findRecordForOwner: vi.fn().mockResolvedValue({ delivery, attempts: [] }),
    } as unknown as EmailRepository;
    const audit = { append: vi.fn() } as unknown as AuditRepository;
    const service = new EmailService(database, repository, audit);

    const result = await service.create(
      {
        requestId: delivery.requestId,
        recipientEmail: " Person@Example.COM ",
        subject: " Notice ",
        textBody: " Body ",
      },
      "user_owner",
      "request-1",
    );

    expect(repository.createWithOutbox).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        createdBy: "user_owner",
        recipientEmail: "person@example.com",
        subject: "Notice",
        textBody: "Body",
        correlationId: "request-1",
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(transaction, {
      actorType: "admin",
      actorId: "user_owner",
      action: "email_delivery.created",
      entityType: "email_delivery",
      entityId: delivery.id,
      requestId: "request-1",
      context: { channel: "email", status: "queued" },
    });
    expect(result).not.toHaveProperty("recipientEmail");
    expect(result).not.toHaveProperty("subject");
    expect(result).not.toHaveProperty("textBody");
  });

  it("rejects reuse of a request id with a different immutable payload", async () => {
    const transaction = {} as AppTransaction;
    const database = {
      transaction: vi.fn(
        async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
          work(transaction),
      ),
    } as unknown as DatabaseService;
    const repository = {
      lockRequest: vi.fn(),
      findByRequestForOwner: vi.fn().mockResolvedValue(delivery),
    } as unknown as EmailRepository;
    const service = new EmailService(database, repository, {
      append: vi.fn(),
    } as unknown as AuditRepository);

    await expect(
      service.create(
        {
          requestId: delivery.requestId,
          recipientEmail: "other@example.com",
          subject: "Notice",
          textBody: "Body",
        },
        "user_owner",
        "request-2",
      ),
    ).rejects.toBeInstanceOf(EmailDeliveryConflictError);
  });
});
