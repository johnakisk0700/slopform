import { Injectable } from "@nestjs/common";
import type { ProviderMessageIngressRow } from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { fitToTranscript } from "../question-set.js";
import { matchesPostEventFeedbackStopCommand } from "../matching/stop-command.js";
import {
  FeedbackLogger,
  type FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PendingFeedbackIngressService } from "./pending-ingress.service.js";
import { FeedbackStopService } from "./stop.service.js";
import type { MaterializeFeedbackIngressResult } from "./materialize.types.js";

/**
 * Post-closure inbound: retain text unless the thread closed on STOP, raise
 * attention, never reopen or schedule AI. STOP still applies.
 */
@Injectable()
export class FeedbackClosedConversationIngressService {
  private readonly logger = new FeedbackLogger(
    FeedbackClosedConversationIngressService.name,
  );

  constructor(
    private readonly ingress: FeedbackIngressRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly audit: AuditRepository,
    private readonly pending: PendingFeedbackIngressService,
    private readonly stop: FeedbackStopService,
  ) {}

  async materialize(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const text = ingress.text?.trim() ?? "";

    if (text.length > 0 && matchesPostEventFeedbackStopCommand(text)) {
      return this.stop.apply(ingress, conversation, correlationId, operation);
    }

    const retainsText = conversation.lifecycle.reason !== "stopped";
    operation.stage("persist");
    await this.pending.applyPending(
      ingress.id,
      async (transaction) => {
        let writtenMessageId: string | null = null;
        if (retainsText && text.length > 0) {
          try {
            const appended = await this.conversations.appendMessage(
              transaction,
              {
                conversationId: conversation._id,
                actor: "participant",
                text: fitToTranscript(text).text,
                at: ingress.observedAt,
                providerMessageId: ingress.providerMessageId,
                ingressId: ingress.id,
              },
            );
            writtenMessageId = appended.message.id;
          } catch (error) {
            if (!(error instanceof FeedbackConversationCapacityError)) {
              throw error;
            }
            this.logger.warn({
              event: "feedback.materialize.transcript_capacity",
              correlationId,
              ingressId: ingress.id,
              conversationId: conversation._id,
            });
          }
        }

        // Attention is anchored on the turn just written; a STOP-closed thread
        // keeps no text, so there is nothing to link to.
        await this.conversations.raiseAttention(transaction, {
          conversationId: conversation._id,
          kind: "post_closure_message",
          messageId: writtenMessageId,
          at: ingress.observedAt,
        });
        await this.audit.append(transaction, {
          actorType: "participant",
          actorId: conversation.respondentParticipantId,
          action: "feedback_conversation.post_closure_message",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId: correlationId,
          context: {
            ingressId: ingress.id,
            campaignId: conversation.campaignId,
            closedBecause: conversation.lifecycle.reason,
            textRetained: retainsText,
          },
        });
        await this.ingress.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "materialized",
          matchedConversationId: conversation._id,
          ...(retainsText ? {} : { text: null }),
        });
      },
      conversation._id,
    );

    this.logger.log({
      event: "feedback.materialize.post_closure",
      correlationId,
      ingressId: ingress.id,
      conversationId: conversation._id,
      closedBecause: conversation.lifecycle.reason,
      textRetained: retainsText,
    });

    // Race still reports inbound_materialized; this path does not inspect the fence result.
    return {
      outcome: "inbound_materialized",
      conversationId: conversation._id,
    };
  }
}
