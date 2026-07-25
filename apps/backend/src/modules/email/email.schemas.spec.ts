import { describe, expect, it } from "vitest";

import {
  createEmailDeliverJobId,
  createEmailDeliverySchema,
  emailDeliverJobDataSchema,
  emailDeliverySchema,
} from "./email.schemas.js";

const deliveryId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const outboxEventId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";

describe("email contracts", () => {
  it("normalizes the recipient at the HTTP boundary", () => {
    expect(
      createEmailDeliverySchema.parse({
        requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
        recipientEmail: "  Person@Example.COM ",
        subject: " Notice ",
        textBody: " Body ",
      }),
    ).toEqual({
      requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
      recipientEmail: "person@example.com",
      subject: "Notice",
      textBody: "Body",
    });
  });

  it("keeps content and the raw address out of the admin response", () => {
    const view = emailDeliverySchema.parse({
      id: deliveryId,
      requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
      recipientMasked: "p***@example.com",
      status: "queued",
      attemptCount: 0,
      lastErrorCode: null,
      nextAttemptAt: null,
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      completedAt: null,
      attempts: [],
    });

    expect(view).not.toHaveProperty("recipientEmail");
    expect(view).not.toHaveProperty("subject");
    expect(view).not.toHaveProperty("textBody");
  });

  it("accepts only the versioned identifier-only delivery envelope", () => {
    expect(
      emailDeliverJobDataSchema.parse({
        schemaVersion: 1,
        deliveryId,
        outboxEventId,
        correlationId: "request-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      deliveryId,
      outboxEventId,
      correlationId: "request-1",
    });
    expect(() =>
      emailDeliverJobDataSchema.parse({
        schemaVersion: 1,
        deliveryId,
        outboxEventId,
        correlationId: "request-1",
        recipientEmail: "person@example.com",
      }),
    ).toThrow();
    expect(createEmailDeliverJobId(outboxEventId)).toBe(
      `email-deliver-v1-${outboxEventId}`,
    );
  });
});
