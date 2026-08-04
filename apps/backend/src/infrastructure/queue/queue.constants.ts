export const QUEUE_PREFIX = "jts";
export const QUEUE_PRODUCER_CONFIG = "jts-producer";
export const QUEUE_WORKER_CONFIG = "jts-worker";
export const ASSISTANT_QUEUE = "assistant";
export const EMAIL_QUEUE = "email-delivery";
/** Legacy feedback topology retained only during the bridge rollout. */
export const FEEDBACK_QUEUE = "feedback";
/**
 * Materialization only, separated from `FEEDBACK_QUEUE` on 2026-07-27.
 *
 * Writing an inbound message into the transcript takes milliseconds; an
 * extraction run holds its slot for the length of a model call. Sharing one
 * queue made the first wait behind the second, and a rehearsal of eighteen
 * concurrent conversations measured the cost: 45 messages reached the
 * transcript after 118 seconds on average and 296 at worst, while 52 provider
 * calls consumed 2340 of the 2364 slot-seconds that existed.
 *
 * The whole design rests on materialization being immediate — the quiet window
 * collects what materialization has already written, the staleness guards read
 * the transcript, and the admin renders it in timestamp order. A queue that is
 * 99% full of model calls does not deliver that, however small the job is.
 */
export const FEEDBACK_INGRESS_QUEUE = "feedback-ingress";
/** One current-state reconciliation job per conversation revision. */
export const FEEDBACK_CONVERSATION_QUEUE = "feedback-conversation";
/** Campaign-level model work, isolated from conversation throughput. */
export const FEEDBACK_SUMMARY_QUEUE = "feedback-summary";
/** Cheap periodic recovery and expiry scans. */
export const FEEDBACK_MAINTENANCE_QUEUE = "feedback-maintenance";
export const REFERENCE_QUEUE = "reference";

export const OUTBOX_RELAY_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
  stackTraceLimit: 3,
};
