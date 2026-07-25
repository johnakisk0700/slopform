import { UnrecoverableError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { EmailOutboxRelayService } from "./email-outbox-relay.service.js";
import {
  EMAIL_JOB_NAMES,
  type EmailJobData,
  type EmailJobName,
} from "./email.schemas.js";
import type { EmailService } from "./email.service.js";
import { EmailProcessor } from "./email.processor.js";

const deliveryId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const outboxEventId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";

function job(overrides?: {
  readonly data?: unknown;
  readonly id?: string;
  readonly name?: string;
}): Job<EmailJobData, void, EmailJobName> {
  return {
    id: overrides?.id ?? `email-deliver-v1-${outboxEventId}`,
    name: overrides?.name ?? EMAIL_JOB_NAMES.deliverV1,
    data:
      overrides?.data ??
      ({
        schemaVersion: 1,
        deliveryId,
        outboxEventId,
        correlationId: "request-1",
      } as const),
  } as unknown as Job<EmailJobData, void, EmailJobName>;
}

describe("EmailProcessor", () => {
  it("loads only authoritative identifiers and records the disabled transport", async () => {
    const email = { processWithoutProvider: vi.fn() };
    const processor = new EmailProcessor(
      email as unknown as EmailService,
      { relay: vi.fn() } as unknown as EmailOutboxRelayService,
    );

    await expect(processor.process(job())).resolves.toBeUndefined();
    expect(email.processWithoutProvider).toHaveBeenCalledWith(
      deliveryId,
      outboxEventId,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("rejects malformed payloads, unknown names and mismatched job ids", async () => {
    const email = { processWithoutProvider: vi.fn() };
    const processor = new EmailProcessor(
      email as unknown as EmailService,
      { relay: vi.fn() } as unknown as EmailOutboxRelayService,
    );

    await expect(processor.process(job({ data: {} }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(
      processor.process(job({ name: "email.unknown" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processor.process(job({ id: "wrong" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(email.processWithoutProvider).not.toHaveBeenCalled();
  });
});
