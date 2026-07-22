export const REFERENCE_QUEUE = "reference";

export const REFERENCE_JOB_NAMES = {
  inspectRecord: "reference.inspect-record",
} as const;

export type ReferenceJobName =
  (typeof REFERENCE_JOB_NAMES)[keyof typeof REFERENCE_JOB_NAMES];
