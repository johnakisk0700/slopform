import { describe, expect, it } from "vitest";

import {
  createEmailDeliverJobId,
  createEmailDeliverySchema,
  emailDeliverJobDataSchema,
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
