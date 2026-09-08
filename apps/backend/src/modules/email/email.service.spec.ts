import type {
  AppTransaction,
  EmailDeliveryAttemptRow,
  EmailDeliveryRow,
} from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { ResendClientError } from "../../integrations/resend/resend.client.js";
import { EmailDeliveryConflictError, EmailService } from "./email.service.js";
import type {
  ClaimedEmailDelivery,
  EmailRepository,
} from "./email.repository.js";

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

const attempt: EmailDeliveryAttemptRow = {
  id: "b7a74cc1-87b5-4c9b-88a0-10ddae7a9a2b",
  deliveryId: delivery.id,
  attemptNumber: 1,
  status: "processing",
  errorCode: null,
  startedAt: new Date("2026-07-25T00:00:00.000Z"),
  completedAt: null,
};

const outboxEventId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const leaseToken = "15b13fb1-72bb-477e-98d0-8c2c7bfb4fb1";
const now = new Date("2026-07-25T00:01:00.000Z");

function createClaimedDelivery(
  overrides?: Partial<ClaimedEmailDelivery>,
): ClaimedEmailDelivery {
  return {
    delivery: {
      ...delivery,
      status: "processing",
      attemptCount: 1,
      leaseToken,
      leaseUntil: new Date("2026-07-25T00:11:00.000Z"),
    },
    attempt,
    outboxEventId,
    firstAttemptStartedAt: attempt.startedAt,
    ...overrides,
  };
}

function createProviderHarness(claimed = createClaimedDelivery()) {
  const transaction = {} as AppTransaction;
  const database = {
    transaction: vi.fn(
      async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
        work(transaction),
    ),
  } as unknown as DatabaseService;
  const repository = {
    claimDelivery: vi.fn().mockResolvedValue(claimed),
    markSent: vi.fn().mockResolvedValue(claimed.delivery),
    markRetryScheduled: vi.fn().mockResolvedValue(claimed.delivery),
    markFailed: vi.fn().mockResolvedValue({
      ...claimed.delivery,
      status: "failed",
    }),
  } as unknown as EmailRepository;
  const audit = { append: vi.fn() } as unknown as AuditRepository;
  return {
    audit,
    claimed,
    database,
    repository,
    service: new EmailService(database, repository, audit),
    transaction,
  };
}

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
        recipientEmail: "person@example.com",
        subject: "Notice",
        textBody: "Body",
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

  it("claims before the provider call and records a successful send after it", async () => {
    const harness = createProviderHarness();
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await harness.service.processWithProvider(
      delivery.id,
      outboxEventId,
      now,
      new Date("2026-07-25T00:11:00.000Z"),
      sendEmail,
    );

    expect(harness.database.transaction).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledWith({
      recipientEmail: delivery.recipientEmail,
      subject: delivery.subject,
      textBody: delivery.textBody,
      idempotencyKey: delivery.id,
    });
    expect(harness.repository.markSent).toHaveBeenCalledWith(
      harness.transaction,
      harness.claimed,
      now,
    );
    expect(harness.audit.append).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({ action: "email_delivery.sent" }),
    );
  });

  it("schedules retryable provider failures with the same durable delivery", async () => {
    const harness = createProviderHarness();
    const sendEmail = vi.fn().mockRejectedValue(new ResendClientError(true, 3));

    await harness.service.processWithProvider(
      delivery.id,
      outboxEventId,
      now,
      new Date("2026-07-25T00:11:00.000Z"),
      sendEmail,
    );

    expect(harness.repository.markRetryScheduled).toHaveBeenCalledWith(
      harness.transaction,
      harness.claimed,
      new Date("2026-07-25T00:01:03.000Z"),
      now,
    );
    expect(harness.repository.markSent).not.toHaveBeenCalled();
    expect(harness.repository.markFailed).not.toHaveBeenCalled();
    expect(harness.audit.append).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({ action: "email_delivery.retry_scheduled" }),
    );
  });

  it("settles permanent provider failures as failed", async () => {
    const harness = createProviderHarness();
    const sendEmail = vi.fn().mockRejectedValue(new ResendClientError(false));

    await harness.service.processWithProvider(
      delivery.id,
      outboxEventId,
      now,
      new Date("2026-07-25T00:11:00.000Z"),
      sendEmail,
    );

    expect(harness.repository.markFailed).toHaveBeenCalledWith(
      harness.transaction,
      harness.claimed,
      now,
    );
    expect(harness.repository.markRetryScheduled).not.toHaveBeenCalled();
    expect(harness.repository.markSent).not.toHaveBeenCalled();
  });

  it("does not classify unexpected provider errors as delivery failures", async () => {
    const harness = createProviderHarness();
    const error = new Error("unexpected test failure");
    const sendEmail = vi.fn().mockRejectedValue(error);

    await expect(
      harness.service.processWithProvider(
        delivery.id,
        outboxEventId,
        now,
        new Date("2026-07-25T00:11:00.000Z"),
        sendEmail,
      ),
    ).rejects.toBe(error);
    expect(harness.repository.markFailed).not.toHaveBeenCalled();
    expect(harness.repository.markRetryScheduled).not.toHaveBeenCalled();
    expect(harness.repository.markSent).not.toHaveBeenCalled();
  });

  it("stops recovery before the provider after the idempotency window or attempt cap", async () => {
    const oldAttempt = createClaimedDelivery({
      firstAttemptStartedAt: new Date("2026-07-24T00:00:00.000Z"),
    });
    const oldHarness = createProviderHarness(oldAttempt);
    const oldSend = vi.fn().mockResolvedValue(undefined);

    await oldHarness.service.processWithProvider(
      delivery.id,
      outboxEventId,
      now,
      new Date("2026-07-25T00:11:00.000Z"),
      oldSend,
    );

    expect(oldSend).not.toHaveBeenCalled();
    expect(oldHarness.repository.markFailed).toHaveBeenCalledOnce();

    const exhausted = createClaimedDelivery({
      attempt: { ...attempt, attemptNumber: 6 },
    });
    const exhaustedHarness = createProviderHarness(exhausted);
    const exhaustedSend = vi.fn().mockResolvedValue(undefined);

    await exhaustedHarness.service.processWithProvider(
      delivery.id,
      outboxEventId,
      now,
      new Date("2026-07-25T00:11:00.000Z"),
      exhaustedSend,
    );

    expect(exhaustedSend).not.toHaveBeenCalled();
    expect(exhaustedHarness.repository.markFailed).toHaveBeenCalledOnce();
  });
});
