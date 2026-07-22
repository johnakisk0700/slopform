import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const REFERENCE_JOB_NAMES = {
  inspectRecordV1: "reference.inspect-record.v1",
} as const;

export const REFERENCE_JOB_SCHEMA_VERSION = 1;

export const createReferenceRecordSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
  })
  .strict();

export const referenceIdSchema = z.object({ id: z.uuid() }).strict();

export const referenceRecordSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
});

export const enqueueReferenceJobSchema = z
  .object({
    recordId: z.uuid(),
    idempotencyKey: z.uuid(),
  })
  .strict();

export const referenceJobDataSchema = z
  .object({
    schemaVersion: z.literal(REFERENCE_JOB_SCHEMA_VERSION),
    recordId: z.uuid(),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export const enqueueReferenceJobResponseSchema = z.object({
  jobId: z.string().min(1),
});

export class CreateReferenceRecordDto extends createZodDto(
  createReferenceRecordSchema,
) {}
export class ReferenceIdDto extends createZodDto(referenceIdSchema) {}
export class ReferenceRecordDto extends createZodDto(referenceRecordSchema) {}
export class EnqueueReferenceJobDto extends createZodDto(
  enqueueReferenceJobSchema,
) {}
export class EnqueueReferenceJobResponseDto extends createZodDto(
  enqueueReferenceJobResponseSchema,
) {}

export type CreateReferenceRecordInput = z.infer<
  typeof createReferenceRecordSchema
>;
export type ReferenceRecordView = z.infer<typeof referenceRecordSchema>;
export type EnqueueReferenceJobInput = z.infer<
  typeof enqueueReferenceJobSchema
>;
export type ReferenceJobData = z.infer<typeof referenceJobDataSchema>;
export type ReferenceJobName =
  (typeof REFERENCE_JOB_NAMES)[keyof typeof REFERENCE_JOB_NAMES];

export function createReferenceInspectJobId(
  recordId: string,
  idempotencyKey: string,
): string {
  return `reference-inspect-v1-${recordId}-${idempotencyKey}`;
}
