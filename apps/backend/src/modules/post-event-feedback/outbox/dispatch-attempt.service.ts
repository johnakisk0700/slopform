import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import {
  FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";
import type { FeedbackOutboxClaimedRow } from "./outbox.types.js";
import { FeedbackOutboundTranscriptService } from "./outbound-transcript.service.js";
import {
  FEEDBACK_SEND_LIMITER,
  type FeedbackSendLimiter,
} from "./session-pacer.js";
import { FEEDBACK_TRANSPORT, type FeedbackTransport } from "./transport.js";
import type { FeedbackSendSlotResult } from "./dispatch-attempt.types.js";
import { FeedbackDispatchPreparationService } from "./dispatch-preparation.service.js";
import { FeedbackDispatchSettlementService } from "./dispatch-settlement.service.js";
import type { FeedbackOutboxDispatchItemResult } from "./dispatcher.types.js";

/**
 * One claimed row from the first kill-switch look through provider send.
 *
 * Per-row errors stay isolated so a bad conversation cannot strand later
 * claims on this replica. The Redis limiter is awaited while the row is still
 * `claimed`; the no-return marker is the last write before `sendText`.
 *
 * Caller: MessageOutboxDispatcherService.dispatchBatch.
 */
@Injectable()
export class FeedbackDispatchAttemptService {
  private readonly logger = new FeedbackLogger(
    FeedbackDispatchAttemptService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly preparation: FeedbackDispatchPreparationService,
    private readonly settlement: FeedbackDispatchSettlementService,
    @Inject(FEEDBACK_TRANSPORT)
    private readonly transport: FeedbackTransport,
    @Inject(FEEDBACK_SEND_LIMITER)
    private readonly sendLimiter: FeedbackSendLimiter,
  ) {}

  async dispatchClaimSafely(
    claim: FeedbackOutboxClaimedRow,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    try {
      return await this.dispatchClaim(claim);
    } catch (error) {
      // The row stays claimed or attempting. Its durable lease, not this
      // process's stack, decides whether recovery may retry or quarantine it.
      this.logger.error({
        event: "feedback.outbox.dispatch_unhandled",
        outboxId: claim.id,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
      return { outboxId: claim.id, outcome: "deferred" };
    }
  }

  private async dispatchClaim(
    claim: FeedbackOutboxClaimedRow,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "dispatch",
      correlationId: claim.id,
      outboxId: claim.id,
      conversationId: claim.conversationId,
      campaignId: claim.campaignId,
      attempt: claim.attemptCount,
    });
    try {
      const result = await this.dispatchClaimOnce(claim, operation);
      operation.complete(result.outcome);
      return result;
    } catch (error) {
      operation.failed(error);
      throw error;
    }
  }

  private async dispatchClaimOnce(
    claim: FeedbackOutboxClaimedRow,
    operation: FeedbackOperationLog,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    operation.stage("initial_guard");
    const firstGuard = await this.preparation.guardCurrentState(claim);
    if (firstGuard.state === "settled") {
      return firstGuard.result;
    }

    operation.stage("transcript");
    const recorded = await this.database.transaction((transaction) =>
      this.outboundTranscript.record(transaction, claim, new Date(), claim.id, {
        claimToken: claim.claimToken,
      }),
    );
    if (recorded.outcome === "cancelled") {
      return { outboxId: claim.id, outcome: "cancelled" };
    }
    if (recorded.outcome === "claim_lost") {
      return { outboxId: claim.id, outcome: "claim_lost" };
    }

    // Global pacing may outlive the initial lease as replicas are added. Keep
    // this exact token alive while waiting, then renew once more after the slot
    // before reading state and crossing the no-return marker.
    operation.stage("send_slot");
    const ownsClaimAfterPacing =
      await this.waitForSendSlotWithClaimHeartbeat(claim);
    if (!ownsClaimAfterPacing) {
      return { outboxId: claim.id, outcome: "claim_lost" };
    }

    const transport = new FeedbackOperationLog(this.logger, {
      operation: "dispatch_transport",
      correlationId: claim.id,
      outboxId: claim.id,
      conversationId: claim.conversationId,
      campaignId: claim.campaignId,
      attempt: claim.attemptCount,
    });
    operation.stage("prepare_send");
    const prepared = await this.preparation.prepare(
      claim,
      firstGuard.phoneAtLaunch,
    );
    if (prepared.state === "settled") {
      return prepared.result;
    }
    const { attempting } = prepared;
    const sendInput = {
      to: prepared.phoneAtLaunch,
      text: claim.body,
      outboxId: claim.id,
    };
    if (!attempting) {
      return { outboxId: claim.id, outcome: "claim_lost" };
    }

    // Sync, non-throwing, no await/IO: last reached boundary if the process
    // dies inside the provider call. Child observer keeps a transport failure
    // after the parent moves on to finalize.
    operation.stage("transport");
    transport.stage("transport");
    let result: Awaited<ReturnType<FeedbackTransport["sendText"]>>;
    try {
      // This is deliberately the first fallible operation after the durable
      // send marker. Every state/consent/phone lookup completed above it.
      result = await this.transport.sendText(sendInput);
      transport.complete(
        result.outcome === "accepted"
          ? "accepted"
          : result.outcome === "not-accepted"
            ? "not_accepted"
            : "unknown",
      );
    } catch (error) {
      transport.failed(error);
      operation.stage("finalize_result");
      return this.settlement.markAmbiguous(
        attempting,
        claim.claimToken,
        "unexpected_transport_error",
        error,
      );
    }

    operation.stage("finalize_result");
    if (result.outcome === "accepted") {
      return this.settlement.finalizeAccepted(
        attempting,
        claim.claimToken,
        result,
      );
    }

    if (result.outcome === "not-accepted") {
      return this.settlement.finalizeNotAccepted(
        attempting,
        claim.claimToken,
        result,
      );
    }

    return this.settlement.finalizeUnknown(
      attempting,
      claim.claimToken,
      result,
    );
  }

  /**
   * Waits for deployment-wide provider capacity without tying the lease length
   * to replica count or backlog size. Renewals are serialized: when this method
   * returns, no heartbeat write can race the final guard or send marker.
   *
   * Losing the token ends this dispatch immediately. The already-started
   * limiter promise has both outcomes handled, so it cannot leak an unhandled
   * rejection if it settles after ownership was lost.
   */
  private async waitForSendSlotWithClaimHeartbeat(
    claim: FeedbackOutboxClaimedRow,
  ): Promise<boolean> {
    const sendSlot: Promise<FeedbackSendSlotResult> = this.sendLimiter
      .waitTurn()
      .then(
        () => ({ state: "granted" }) as const,
        (error: unknown) => ({ state: "failed", error }) as const,
      );
    let heartbeatTimer: NodeJS.Timeout | undefined;

    try {
      while (true) {
        const heartbeatDue = new Promise<{ readonly state: "heartbeat" }>(
          (resolve) => {
            heartbeatTimer = setTimeout(
              () => resolve({ state: "heartbeat" }),
              FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS,
            );
            heartbeatTimer.unref();
          },
        );
        const event = await Promise.race([sendSlot, heartbeatDue]);
        clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;

        if (event.state === "failed") {
          throw event.error;
        }

        const renewed = await this.outbox.renewDispatchClaim(
          claim.id,
          claim.claimToken,
          new Date(),
        );
        if (!renewed) {
          return false;
        }
        if (event.state === "granted") {
          return true;
        }
      }
    } finally {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
    }
  }
}
