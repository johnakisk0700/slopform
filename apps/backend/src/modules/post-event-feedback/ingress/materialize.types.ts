import type { FeedbackMaterializeOutcome } from "../metrics.service.js";

export interface MaterializeFeedbackIngressInput {
  readonly ingressId: string;
  readonly correlationId: string;
}

export interface MaterializeFeedbackIngressResult {
  readonly outcome: FeedbackMaterializeOutcome;
  readonly conversationId?: string;
  readonly extractJobId?: string;
  readonly stopAckOutboxId?: string;
  readonly correlatedOutboxId?: string;
}
