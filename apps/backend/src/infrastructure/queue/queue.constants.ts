export const QUEUE_PREFIX = "jts";
export const QUEUE_PRODUCER_CONFIG = "jts-producer";
export const QUEUE_WORKER_CONFIG = "jts-worker";
export const ASSISTANT_QUEUE = "assistant";
export const EMAIL_QUEUE = "email-delivery";
export const FEEDBACK_QUEUE = "feedback";
export const REFERENCE_QUEUE = "reference";

export const OUTBOX_RELAY_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
  stackTraceLimit: 3,
};
