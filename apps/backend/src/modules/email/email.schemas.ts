import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const EMAIL_DELIVERY_STATUSES = [
  "queued",
  "processing",
  "retry_scheduled",
  "blocked",
  "sent",
  "failed",
] as const;
export const EMAIL_ATTEMPT_STATUSES = [
  "processing",
  "retry_scheduled",
  "blocked",
  "sent",
  "failed",
  "unknown",
] as const;
export const EMAIL_FAILURE_CODES = [
  "provider_not_configured",
  "queue_unavailable",
  "lease_expired",
  "delivery_failed",
] as const;

export const EMAIL_JOB_NAMES = {
  relayOutboxV1: "email.relay-outbox.v1",
  deliverV1: "email.deliver.v1",
} as const;
export const EMAIL_JOB_SCHEMA_VERSION = 1;

export const createEmailDeliverySchema = z
  .object({
    requestId: z.uuid(),
    recipientEmail: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    subject: z.string().trim().min(1).max(200),
    textBody: z.string().trim().min(1).max(100_000),
  })
  .strict();
export const emailDeliveryIdSchema = z.object({ id: z.uuid() }).strict();
export const emailPrincipalSchema = z.string().min(1).max(200);
export const emailCorrelationIdSchema = z.string().min(1).max(128);

export const emailAttemptSchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    status: z.enum(EMAIL_ATTEMPT_STATUSES),
    errorCode: z.enum(EMAIL_FAILURE_CODES).nullable(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const emailDeliverySchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    recipientMasked: z.string().min(3).max(320),
    status: z.enum(EMAIL_DELIVERY_STATUSES),
    attemptCount: z.number().int().nonnegative(),
    lastErrorCode: z.enum(EMAIL_FAILURE_CODES).nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    attempts: z.array(emailAttemptSchema),
  })
  .strict();
export const emailDeliveryListSchema = z
  .object({ items: z.array(emailDeliverySchema).max(50) })
  .strict();

export const emailRelayJobDataSchema = z
  .object({
    schemaVersion: z.literal(EMAIL_JOB_SCHEMA_VERSION),
    correlationId: z.string().min(1).max(128),
  })
  .strict();
export const emailDeliverJobDataSchema = z
  .object({
    schemaVersion: z.literal(EMAIL_JOB_SCHEMA_VERSION),
    deliveryId: z.uuid(),
    outboxEventId: z.uuid(),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CreateEmailDeliveryDto extends createZodDto(
  createEmailDeliverySchema,
) {}
export class EmailDeliveryIdDto extends createZodDto(emailDeliveryIdSchema) {}
const EmailPrincipalDtoBase = createZodDto(
  emailPrincipalSchema,
) as unknown as new () => object;
const EmailCorrelationIdDtoBase = createZodDto(
  emailCorrelationIdSchema,
) as unknown as new () => object;
export class EmailPrincipalDto extends EmailPrincipalDtoBase {}
export class EmailCorrelationIdDto extends EmailCorrelationIdDtoBase {}
export class EmailDeliveryDto extends createZodDto(emailDeliverySchema) {}
export class EmailDeliveryListDto extends createZodDto(
  emailDeliveryListSchema,
) {}

export type CreateEmailDeliveryInput = z.input<
  typeof createEmailDeliverySchema
>;
export type EmailDeliveryStatus = z.infer<typeof emailDeliverySchema>["status"];
export type EmailDeliveryView = z.infer<typeof emailDeliverySchema>;
export type EmailDeliveryListView = z.infer<typeof emailDeliveryListSchema>;
export type EmailRelayJobData = z.infer<typeof emailRelayJobDataSchema>;
export type EmailDeliverJobData = z.infer<typeof emailDeliverJobDataSchema>;
export type EmailJobData = EmailRelayJobData | EmailDeliverJobData;
export type EmailJobName =
  (typeof EMAIL_JOB_NAMES)[keyof typeof EMAIL_JOB_NAMES];

export function createEmailDeliverJobId(outboxEventId: string): string {
  return `email-deliver-v1-${outboxEventId}`;
}
