import { Logger } from "@nestjs/common";
import type { MessageOutboxRow } from "@slopform/database";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { createFeedbackClosingDedupeKey } from "../extraction/extraction.schemas.js";
import { createFeedbackStopAckDedupeKey } from "../question-set.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import { deliveryFor } from "../inbox/conversation.view.js";
import { MessageOutboxDispatcherService } from "./dispatcher.service.js";
import {
  FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS,
  FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
} from "./outbox.repository.js";
import type {
  FeedbackOutboxClaimedRow,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";
import type { FeedbackOutboundTranscriptService } from "./outbound-transcript.service.js";
import type { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import type { FeedbackSendLimiter } from "./session-pacer.js";
import type { FeedbackTransport } from "./transport.js";

const outboxId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const conversationId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const claimToken = "118234ec-14f8-4c2a-90f3-330a092e4f60";
const snapshotIngressId = "e2d32755-d43f-42eb-a209-d731d1dd47d7";
const snapshotControlChangedAt = new Date("2026-07-24T23:55:00.000Z");

describe("MessageOutboxDispatcherService", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("paces, commits the pre-send marker, then enters transport", async () => {
    const harness = createHarness();

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      claimedCount: 1,
      items: [{ outboxId, outcome: "sent" }],
    });

    expect(harness.limiter.waitTurn).toHaveBeenCalledTimes(1);
    expect(harness.limiter.waitTurn.mock.invocationCallOrder[0]).toBeLessThan(
      harness.repository.renewDispatchClaim.mock
        .invocationCallOrder[0] as number,
    );
    expect(
      harness.repository.renewDispatchClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.repository.markDispatchAttemptStarted.mock
        .invocationCallOrder[0] as number,
    );
    expect(
      harness.repository.markDispatchAttemptStarted.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.transport.sendText.mock.invocationCallOrder[0] as number,
    );
    expect(harness.conversations.findById).toHaveBeenCalledTimes(2);
    expect(harness.repository.lockConversation).toHaveBeenCalledWith(
      harness.transaction,
      conversationId,
    );
    expect(harness.ingress.lockInboundPhone).toHaveBeenCalledWith(
      harness.transaction,
      "+306900000001",
    );
    expect(
      harness.ingress.lockInboundPhone.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.repository.lockConversation.mock.invocationCallOrder[0] as number,
    );
    expect(
      harness.repository.lockConversation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.conversations.findById.mock.invocationCallOrder[1] as number,
    );
    expect(
      harness.repository.lockConversation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.campaigns.findCampaignByIdForShare.mock
        .invocationCallOrder[0] as number,
    );
    expect(
      harness.campaigns.findCampaignByIdForShare.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.conversations.findById.mock.invocationCallOrder[1] as number,
    );
    expect(harness.campaigns.findCampaignByIdForShare).toHaveBeenCalledWith(
      harness.transaction,
      claimedRow().campaignId,
    );
    expect(
      harness.participants.findByIdForUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.repository.markDispatchAttemptStarted.mock
        .invocationCallOrder[0] as number,
    );
    expect(
      harness.conversations.findById.mock.invocationCallOrder[1],
    ).toBeLessThan(
      harness.repository.markDispatchAttemptStarted.mock
        .invocationCallOrder[0] as number,
    );
    expect(harness.transport.sendText).toHaveBeenCalledWith({
      to: "+306900000001",
      text: "Ευχαριστούμε!",
      outboxId,
    });
    expect(harness.repository.markDispatchSent).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      expect.objectContaining({
        providerLogId: "42",
        providerMessageId: "wamid.1",
        deliveryStatus: "sent",
      }),
    );
  });

  it("lets two replicas claim one row only once", async () => {
    const harness = createHarness();
    const pendingClaims = [claimedRow()];
    harness.repository.claimDispatchBatch.mockImplementation(async () => {
      const claim = pendingClaims.shift();
      return claim ? [claim] : [];
    });
    const second = createServiceFromHarness(harness);

    const [firstResult, secondResult] = await Promise.all([
      harness.service.dispatchBatch(),
      second.dispatchBatch(),
    ]);

    expect(firstResult.claimedCount + secondResult.claimedCount).toBe(1);
    expect(harness.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("starts every bounded claim lane before a slow first lane completes", async () => {
    const secondId = "14b0d0f3-8cf0-4420-ae96-8eb77a21915e";
    const secondToken = "22b43614-8de9-48bd-a3e1-290427cfbbca";
    const secondConversationId = "f0562a6b-d334-43f0-a029-43298a559ac0";
    const harness = createHarness({
      claims: [
        claimedRow(),
        claimedRow({
          id: secondId,
          conversationId: secondConversationId,
          claimToken: secondToken,
        }),
      ],
    });
    const releases: Array<() => void> = [];
    harness.limiter.waitTurn.mockImplementation(
      () =>
        new Promise((resolve) => releases.push(() => resolve({ waitedMs: 0 }))),
    );

    const dispatched = harness.service.dispatchBatch();

    await vi.waitFor(() =>
      expect(harness.limiter.waitTurn).toHaveBeenCalledTimes(2),
    );
    releases.splice(0).forEach((release) => release());

    await expect(dispatched).resolves.toMatchObject({
      claimedCount: 2,
      items: [
        { outboxId, outcome: "sent" },
        { outboxId: secondId, outcome: "sent" },
      ],
    });
  });

  it("dispatches claims from the same conversation strictly in FIFO order", async () => {
    const secondId = "14b0d0f3-8cf0-4420-ae96-8eb77a21915e";
    const secondToken = "22b43614-8de9-48bd-a3e1-290427cfbbca";
    const harness = createHarness({
      claims: [
        claimedRow(),
        claimedRow({
          id: secondId,
          claimToken: secondToken,
          createdAt: new Date("2026-07-25T00:00:01.000Z"),
        }),
      ],
    });
    let finishFirstSend: (() => void) | undefined;
    harness.transport.sendText
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSend = () =>
              resolve({
                outcome: "accepted",
                providerLogId: "42",
                providerMessageId: "wamid.1",
                providerStatus: "sent",
              });
          }),
      )
      .mockResolvedValueOnce({
        outcome: "accepted",
        providerLogId: "43",
        providerMessageId: "wamid.2",
        providerStatus: "sent",
      });

    const dispatched = harness.service.dispatchBatch();
    await vi.waitFor(() =>
      expect(harness.transport.sendText).toHaveBeenCalledTimes(1),
    );
    expect(harness.limiter.waitTurn).toHaveBeenCalledTimes(1);

    finishFirstSend?.();
    await expect(dispatched).resolves.toMatchObject({
      items: [
        { outboxId, outcome: "sent" },
        { outboxId: secondId, outcome: "sent" },
      ],
    });
    expect(harness.limiter.waitTurn).toHaveBeenCalledTimes(2);
    expect(
      harness.repository.markDispatchSent.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.limiter.waitTurn.mock.invocationCallOrder[1] as number,
    );
  });

  it("keeps a pre-send claim alive when limiter wait exceeds its lease", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      let grantSendSlot: (() => void) | undefined;
      harness.limiter.waitTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            grantSendSlot = () => resolve({ waitedMs: 0 });
          }),
      );

      const dispatched = harness.service.dispatchBatch();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.limiter.waitTurn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(FEEDBACK_OUTBOX_DISPATCH_LEASE_MS + 1);
      expect(
        harness.repository.renewDispatchClaim.mock.calls.length,
      ).toBeGreaterThanOrEqual(
        Math.floor(
          FEEDBACK_OUTBOX_DISPATCH_LEASE_MS /
            FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS,
        ),
      );
      expect(
        harness.repository.markDispatchAttemptStarted,
      ).not.toHaveBeenCalled();

      grantSendSlot?.();
      await vi.advanceTimersByTimeAsync(0);
      await expect(dispatched).resolves.toMatchObject({
        items: [{ outboxId, outcome: "sent" }],
      });
      expect(harness.repository.renewDispatchClaim).toHaveBeenLastCalledWith(
        outboxId,
        claimToken,
        expect.any(Date),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the heartbeat without sending when ownership is lost mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.limiter.waitTurn.mockImplementation(
        () => new Promise(() => undefined),
      );
      harness.repository.renewDispatchClaim.mockResolvedValueOnce(undefined);

      const dispatched = harness.service.dispatchBatch();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS);

      await expect(dispatched).resolves.toMatchObject({
        items: [{ outboxId, outcome: "claim_lost" }],
      });
      expect(
        harness.repository.markDispatchAttemptStarted,
      ).not.toHaveBeenCalled();
      expect(harness.transport.sendText).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the heartbeat timer when the global limiter fails", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.limiter.waitTurn.mockRejectedValue(
        new Error("redis unavailable"),
      );

      await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
        items: [{ outboxId, outcome: "deferred" }],
      });
      expect(harness.repository.renewDispatchClaim).not.toHaveBeenCalled();
      expect(
        harness.repository.markDispatchAttemptStarted,
      ).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send when the token-fenced attempt marker loses its claim", async () => {
    const harness = createHarness();
    harness.repository.markDispatchAttemptStarted.mockResolvedValue(undefined);

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "claim_lost" }],
    });
    expect(harness.transport.sendText).not.toHaveBeenCalled();
    expect(harness.repository.markDispatchSent).not.toHaveBeenCalled();
  });

  it("does not send when another replica replaced the claim during pacing", async () => {
    const harness = createHarness();
    harness.repository.renewDispatchClaim.mockResolvedValue(undefined);

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "claim_lost" }],
    });
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("leaves a pre-marker crash safely claimed and sends only after a later reclaim", async () => {
    const harness = createHarness();
    const reclaimedToken = "ef021179-8e20-41ca-b6ad-d04cd4be3cd0";
    harness.repository.claimDispatchBatch
      .mockResolvedValueOnce([claimedRow()])
      .mockResolvedValueOnce([claimedRow({ claimToken: reclaimedToken })]);
    harness.limiter.waitTurn
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce({ waitedMs: 0 });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "deferred" }],
    });
    expect(harness.repository.releaseDispatchClaim).not.toHaveBeenCalled();
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();

    await harness.service.dispatchBatch();

    expect(harness.repository.markDispatchAttemptStarted).toHaveBeenCalledWith(
      outboxId,
      reclaimedToken,
      expect.any(Date),
      FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
      null,
      harness.transaction,
    );
    expect(harness.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("quarantines an expired post-marker attempt instead of claiming it", async () => {
    const harness = createHarness({ claims: [] });
    const expired = attemptingRow(claimedRow());
    const legacy = {
      ...claimedRow(),
      status: "sending",
      claimToken: null,
      claimExpiresAt: null,
      sendStartedAt: null,
      attemptCount: 0,
    } as MessageOutboxRow;
    harness.repository.findExpiredDispatchAttempts.mockResolvedValue([expired]);
    harness.repository.findStaleLegacySending.mockResolvedValue([legacy]);
    harness.repository.quarantineExpiredDispatchAttempt.mockResolvedValue(
      expired,
    );
    harness.repository.quarantineStaleLegacySending.mockResolvedValue(legacy);

    await expect(harness.service.dispatchBatch()).resolves.toEqual({
      claimedCount: 0,
      quarantinedCount: 2,
      items: [],
    });
    expect(harness.conversations.markAwaitingHuman).toHaveBeenCalledTimes(1);
    expect(
      harness.repository.cancelQueuedAutomatedOutboxForConversation,
    ).toHaveBeenCalledWith(harness.transaction, conversationId, null);
    expect(harness.conversations.raiseAttention).toHaveBeenCalledWith({
      conversationId,
      kind: "undelivered_message",
      messageId: null,
      at: expect.any(Date),
    });
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("keeps an expired attempt recoverable when its human-review projection fails", async () => {
    const harness = createHarness({ claims: [] });
    harness.repository.findExpiredDispatchAttempts.mockResolvedValue([
      attemptingRow(claimedRow()),
    ]);
    harness.conversations.markAwaitingHuman.mockRejectedValue(
      new Error("mongo unavailable"),
    );

    await expect(harness.service.dispatchBatch()).resolves.toEqual({
      claimedCount: 0,
      quarantinedCount: 0,
      items: [],
    });
    expect(
      harness.repository.quarantineExpiredDispatchAttempt,
    ).toHaveBeenCalled();
  });

  it("persists an unknown provider outcome as ambiguous and never reclaims it", async () => {
    const harness = createHarness();
    harness.repository.claimDispatchBatch
      .mockResolvedValueOnce([claimedRow()])
      .mockResolvedValueOnce([]);
    harness.transport.sendText.mockResolvedValue({
      outcome: "unknown",
      reason: "timeout",
      providerLogId: "42",
    });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "ambiguous" }],
    });
    expect(harness.repository.markDispatchAmbiguous).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      expect.any(Date),
      "transport_unknown:timeout",
      "42",
      harness.transaction,
    );
    expect(harness.conversations.markAwaitingHuman).toHaveBeenCalledWith({
      conversationId,
      at: expect.any(Date),
    });
    expect(
      harness.repository.cancelQueuedAutomatedOutboxForConversation,
    ).toHaveBeenCalledWith(harness.transaction, conversationId, null);
    expect(
      harness.repository.markDispatchAmbiguous.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.conversations.raiseAttention.mock
        .invocationCallOrder[0] as number,
    );

    await harness.service.dispatchBatch();

    expect(harness.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("preserves and dispatches the exact STOP acknowledgement when an older attempt becomes ambiguous", async () => {
    const oldOutboxId = "14b0d0f3-8cf0-4420-ae96-8eb77a21915e";
    const oldAttempt = attemptingRow(
      claimedRow({ id: oldOutboxId, createdAt: new Date("2026-07-24") }),
    );
    const acknowledgement = claimedRow({
      kind: "system",
      dedupeKey: createFeedbackStopAckDedupeKey(conversationId),
    });
    const harness = createHarness({ claims: [acknowledgement] });
    harness.repository.findExpiredDispatchAttempts.mockResolvedValue([
      oldAttempt,
    ]);
    harness.repository.quarantineExpiredDispatchAttempt.mockResolvedValue({
      ...oldAttempt,
      status: "ambiguous",
      claimExpiresAt: null,
    });
    harness.repository.listTerminalDispatchCandidates.mockResolvedValue([
      { conversationId, outboxId },
    ]);
    harness.conversations.listCurrentTerminalOutboxIds.mockResolvedValue([
      outboxId,
    ]);
    harness.conversations.findById.mockResolvedValue(
      conversation("human", "stopped", { terminalOutboxId: outboxId }),
    );
    harness.participants.findById.mockResolvedValue(participant(false));

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      quarantinedCount: 1,
      items: [{ outboxId, outcome: "sent" }],
    });
    expect(
      harness.repository.cancelQueuedAutomatedOutboxForConversation,
    ).toHaveBeenCalledWith(harness.transaction, conversationId, outboxId);
    expect(harness.repository.claimDispatchBatch).toHaveBeenCalledWith(
      expect.any(Date),
      undefined,
      undefined,
      [outboxId],
    );
    expect(harness.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("re-checks human control after pacing and cancels a bot row", async () => {
    const harness = createHarness();
    harness.conversations.findById
      .mockResolvedValueOnce(conversation("bot"))
      .mockResolvedValueOnce(conversation("human"));

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "human_control",
      harness.transaction,
    );
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("re-checks current consent after pacing and cancels before the marker", async () => {
    const harness = createHarness();
    harness.participants.findById.mockResolvedValueOnce(participant(true));
    harness.participants.findByIdForUpdate.mockResolvedValueOnce(
      participant(false),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "consent_withdrawn",
      harness.transaction,
    );
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("keeps a cancelled audit-intent turn when a correction supersedes a persisted ordinary reply", async () => {
    const harness = createHarness();
    let durableRow: MessageOutboxRow = claimedRow();
    harness.repository.finishDispatchClaimBeforeAttempt.mockImplementation(
      async (_id, _token, status, _at, lastError) => {
        durableRow = {
          ...durableRow,
          status,
          claimExpiresAt: null,
          lastError,
        };
        return durableRow;
      },
    );
    harness.outboundLogs.findLogByOutboxId.mockResolvedValue(
      extractionReplyLog({
        latestMessageSeq: 1,
        participantIngressIds: [snapshotIngressId],
      }),
    );
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        messages: [
          { seq: 1, actor: "participant", outboxId: null },
          { seq: 2, actor: "participant", outboxId: null },
        ],
      }),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });

    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "superseded_by_newer_testimony",
      harness.transaction,
    );
    expect(harness.ingress.hasInboundBeyondSnapshot).not.toHaveBeenCalled();
    // Deliberately exposes the remaining projection seam: Mongo keeps the bot
    // audit-intent turn even though PostgreSQL proves it never crossed provider
    // entry. Extraction input must filter that turn by the durable outbox state.
    expect(harness.outboundTranscript.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: outboxId }),
      expect.any(Date),
      outboxId,
      { claimToken },
    );
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
    expect(deliveryFor(outboxId, new Map([[outboxId, durableRow]]))).toEqual({
      outboxId,
      outboxStatus: "cancelled",
      deliveryStatus: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });
  });

  it("cancels an ordinary reply when a newer durable inbound is still pending", async () => {
    const harness = createHarness();
    harness.outboundLogs.findLogByOutboxId.mockResolvedValue(
      extractionReplyLog({
        latestMessageSeq: 1,
        participantIngressIds: [snapshotIngressId],
      }),
    );
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        messages: [{ seq: 1, actor: "participant", outboxId: null }],
      }),
    );
    harness.ingress.hasInboundBeyondSnapshot.mockResolvedValue(true);

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });

    expect(harness.ingress.hasInboundBeyondSnapshot).toHaveBeenCalledWith(
      harness.transaction,
      {
        phoneE164: "+306900000001",
        conversationId,
        snapshotIngressIds: [snapshotIngressId],
      },
    );
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "superseded_by_newer_testimony",
      harness.transaction,
    );
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("cancels an ordinary reply after bot control completed an ABA", async () => {
    const harness = createHarness();
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        controlSource: "staff_action",
        controlChangedAt: new Date("2026-07-25T00:05:00.000Z"),
        workRevision: 8,
      }),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });

    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "superseded_by_newer_work",
      harness.transaction,
    );
    expect(harness.ingress.hasInboundBeyondSnapshot).not.toHaveBeenCalled();
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("cancels an ordinary reply after a newer campaign-resume generation", async () => {
    const harness = createHarness();
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        workRevision: 8,
        campaignResumeGeneration: 5,
      }),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });

    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "superseded_by_newer_work",
      harness.transaction,
    );
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("fails closed for a historical ordinary-reply log without generation evidence", async () => {
    const harness = createHarness();
    const log = extractionReplyLog();
    const { changedAt: _changedAt, ...historicalControl } =
      log.conversationState.control;
    const { work: _work, ...historicalState } = log.conversationState;
    harness.outboundLogs.findLogByOutboxId.mockResolvedValue({
      ...log,
      conversationState: {
        ...historicalState,
        control: historicalControl,
      },
    });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });

    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "outbound_snapshot_invalid",
      harness.transaction,
    );
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("fails before the marker when the participant row disappeared", async () => {
    const harness = createHarness();
    harness.participants.findById.mockResolvedValue(undefined);

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "failed" }],
    });
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "failed",
      expect.any(Date),
      "participant_missing",
    );
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
  });

  it("allows only the current transcript commitment while awaiting human", async () => {
    const current = createHarness({
      claims: [
        claimedRow({
          dedupeKey: `feedback-reply-${conversationId}-3`,
        }),
      ],
    });
    current.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        awaitingHuman: true,
        messages: [{ seq: 3, actor: "bot", outboxId }],
      }),
    );

    await expect(current.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "sent" }],
    });
    expect(current.transport.sendText).toHaveBeenCalledTimes(1);

    const stale = createHarness();
    stale.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        awaitingHuman: true,
        messages: [
          {
            seq: 4,
            actor: "bot",
            outboxId: "14b0d0f3-8cf0-4420-ae96-8eb77a21915e",
          },
        ],
      }),
    );

    await expect(stale.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(
      stale.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "awaiting_human",
    );
    expect(stale.transport.sendText).not.toHaveBeenCalled();
  });

  it("keeps a current human-handoff promise valid after a later participant fragment", async () => {
    const harness = createHarness();
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        awaitingHuman: true,
        cursorSeq: 2,
        messages: [
          { seq: 3, actor: "bot", outboxId },
          { seq: 4, actor: "participant", outboxId: null },
        ],
      }),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "sent" }],
    });
    expect(harness.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("does not exempt an old bot row when a safety-only run added no commitment", async () => {
    const harness = createHarness();
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", undefined, {
        awaitingHuman: true,
        cursorSeq: 3,
        messages: [
          { seq: 2, actor: "bot", outboxId },
          { seq: 3, actor: "participant", outboxId: null },
        ],
      }),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("releases a paused campaign claim so resume can dispatch it", async () => {
    const harness = createHarness();
    harness.campaigns.findCampaignById.mockResolvedValue({ status: "paused" });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "held" }],
    });
    expect(harness.repository.releaseDispatchClaim).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      expect.any(Date),
      "campaign_paused",
    );
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("honors a pause that wins before the final shared campaign lock", async () => {
    const harness = createHarness();
    harness.campaigns.findCampaignByIdForShare.mockResolvedValue({
      status: "paused",
    });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "held" }],
    });

    expect(harness.campaigns.findCampaignById).toHaveBeenCalledTimes(1);
    expect(harness.campaigns.findCampaignByIdForShare).toHaveBeenCalledTimes(1);
    expect(harness.repository.releaseDispatchClaim).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      expect.any(Date),
      "campaign_paused",
      harness.transaction,
    );
    expect(
      harness.repository.markDispatchAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("cancels a closed campaign claim instead of stranding it pending", async () => {
    const harness = createHarness();
    harness.campaigns.findCampaignById.mockResolvedValue({ status: "closed" });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "cancelled",
      expect.any(Date),
      "campaign_closed",
    );
    expect(harness.repository.releaseDispatchClaim).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("fails an orphaned campaign claim instead of stranding it pending", async () => {
    const harness = createHarness();
    harness.campaigns.findCampaignById.mockResolvedValue(undefined);

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "failed" }],
    });
    expect(
      harness.repository.finishDispatchClaimBeforeAttempt,
    ).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      "failed",
      expect.any(Date),
      "campaign_missing",
    );
    expect(harness.repository.releaseDispatchClaim).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("allows the human's own staff row while control is human", async () => {
    const harness = createHarness({
      claims: [claimedRow({ kind: "staff" })],
      control: "human",
    });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "sent" }],
    });
    expect(harness.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("cancels stale bot copy after STOP but still sends the STOP acknowledgement", async () => {
    const stale = createHarness();
    stale.conversations.findById.mockResolvedValue(
      conversation("bot", "stopped"),
    );

    await expect(stale.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(stale.transport.sendText).not.toHaveBeenCalled();

    const acknowledgement = createHarness({
      claims: [
        claimedRow({
          kind: "system",
          dedupeKey: createFeedbackStopAckDedupeKey(conversationId),
        }),
      ],
    });
    acknowledgement.conversations.findById.mockResolvedValue(
      conversation("human", "stopped", { terminalOutboxId: outboxId }),
    );
    acknowledgement.participants.findById.mockResolvedValue(participant(false));

    await expect(
      acknowledgement.service.dispatchBatch(),
    ).resolves.toMatchObject({
      items: [{ outboxId, outcome: "sent" }],
    });
    expect(acknowledgement.transport.sendText).toHaveBeenCalledTimes(1);
    expect(acknowledgement.participants.findById).not.toHaveBeenCalled();
  });

  it.each(["paused", "closed"] as const)(
    "dispatches only the exact STOP acknowledgement while its campaign is %s",
    async (campaignStatus) => {
      const exact = createHarness({
        claims: [
          claimedRow({
            kind: "system",
            dedupeKey: createFeedbackStopAckDedupeKey(conversationId),
          }),
        ],
      });
      exact.campaigns.findCampaignById.mockResolvedValue({
        status: campaignStatus,
      });
      exact.campaigns.findCampaignByIdForShare.mockResolvedValue({
        status: campaignStatus,
      });
      exact.conversations.findById.mockResolvedValue(
        conversation("human", "stopped", { terminalOutboxId: outboxId }),
      );

      await expect(exact.service.dispatchBatch()).resolves.toMatchObject({
        items: [{ outboxId, outcome: "sent" }],
      });
      expect(exact.repository.markDispatchAttemptStarted).toHaveBeenCalledWith(
        outboxId,
        claimToken,
        expect.any(Date),
        FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
        outboxId,
        exact.transaction,
      );

      const impostor = createHarness({
        claims: [
          claimedRow({
            kind: "system",
            dedupeKey: createFeedbackStopAckDedupeKey(conversationId),
          }),
        ],
      });
      impostor.campaigns.findCampaignById.mockResolvedValue({
        status: campaignStatus,
      });
      impostor.conversations.findById.mockResolvedValue(
        conversation("human", "stopped", {
          terminalOutboxId: "22b43614-8de9-48bd-a3e1-290427cfbbca",
        }),
      );

      await expect(impostor.service.dispatchBatch()).resolves.toMatchObject({
        items: [
          {
            outboxId,
            outcome: campaignStatus === "paused" ? "held" : "cancelled",
          },
        ],
      });
      expect(
        impostor.repository.markDispatchAttemptStarted,
      ).not.toHaveBeenCalled();
      expect(impostor.transport.sendText).not.toHaveBeenCalled();
    },
  );

  it("allows only the canonical closing row after completion", async () => {
    const stale = createHarness({
      claims: [
        claimedRow({
          kind: "reply",
          dedupeKey: `feedback-reply-${conversationId}-3`,
        }),
      ],
    });
    stale.conversations.findById.mockResolvedValue(
      conversation("bot", "completed"),
    );

    await expect(stale.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(stale.transport.sendText).not.toHaveBeenCalled();

    const closing = createHarness({
      claims: [
        claimedRow({
          kind: "reply",
          dedupeKey: createFeedbackClosingDedupeKey(conversationId, 3, 7),
        }),
      ],
    });
    closing.conversations.findById.mockResolvedValue(
      conversation("bot", "completed", { terminalOutboxId: outboxId }),
    );

    await expect(closing.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "sent" }],
    });
    expect(closing.transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("cancels an anchored closing row that MongoDB did not record as winner", async () => {
    const harness = createHarness({
      claims: [
        claimedRow({
          kind: "reply",
          dedupeKey: createFeedbackClosingDedupeKey(conversationId, 2),
        }),
      ],
    });
    harness.conversations.findById.mockResolvedValue(
      conversation("bot", "completed", {
        terminalOutboxId: "14b0d0f3-8cf0-4420-ae96-8eb77a21915e",
      }),
    );

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "cancelled" }],
    });
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });

  it("does not send canonical terminal copy before MongoDB commits closure", async () => {
    const harness = createHarness({
      claims: [
        claimedRow({
          kind: "reply",
          dedupeKey: createFeedbackClosingDedupeKey(conversationId, 3, 7),
        }),
      ],
    });

    await expect(harness.service.dispatchBatch()).resolves.toMatchObject({
      items: [{ outboxId, outcome: "held" }],
    });
    expect(harness.repository.releaseDispatchClaim).toHaveBeenCalledWith(
      outboxId,
      claimToken,
      expect.any(Date),
      "terminal_transition_pending",
    );
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.transport.sendText).not.toHaveBeenCalled();
  });
});

function claimedRow(
  overrides: Partial<MessageOutboxRow> = {},
): FeedbackOutboxClaimedRow {
  return {
    id: outboxId,
    conversationId,
    campaignId: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
    kind: "reply",
    body: "Ευχαριστούμε!",
    status: "claimed",
    dedupeKey: "conversation:1:cursor:3",
    createdByStaff: null,
    providerLogId: null,
    providerMessageId: null,
    deliveryStatus: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    deliveryUpdatedAt: null,
    claimToken,
    claimExpiresAt: new Date(Date.now() + 60_000),
    sendStartedAt: null,
    attemptCount: 0,
    lastError: null,
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    updatedAt: new Date("2026-07-25T00:00:00.000Z"),
    ...overrides,
  } as FeedbackOutboxClaimedRow;
}

function attemptingRow(row: FeedbackOutboxClaimedRow): MessageOutboxRow {
  return {
    ...row,
    status: "attempting",
    sendStartedAt: new Date(),
    attemptCount: row.attemptCount + 1,
  };
}

function conversation(
  control: "bot" | "human",
  closedReason?: "completed" | "declined" | "stopped" | "expired" | "cancelled",
  overrides: {
    readonly awaitingHuman?: boolean;
    readonly cursorSeq?: number;
    readonly terminalOutboxId?: string | null;
    readonly controlSource?: "launch" | "staff_action";
    readonly controlChangedAt?: Date;
    readonly workRevision?: number;
    readonly executionEpoch?: number;
    readonly campaignResumeGeneration?: number;
    readonly messages?: readonly {
      readonly seq: number;
      readonly actor: "bot" | "participant" | "staff";
      readonly outboxId: string | null;
    }[];
  } = {},
) {
  return {
    _id: conversationId,
    respondentParticipantId: "b2c3d4e5-f607-4809-8a1b-2c3d4e5f6071",
    phoneAtLaunch: "+306900000001",
    lifecycle: closedReason
      ? {
          state: "closed",
          reason: closedReason,
          closedAt: new Date(),
          terminalOutboxId: overrides.terminalOutboxId,
        }
      : { state: "open", reason: null, closedAt: null },
    control: {
      mode: control,
      source: overrides.controlSource ?? "launch",
      changedAt: overrides.controlChangedAt ?? snapshotControlChangedAt,
    },
    work: {
      // N+1 is the ordinary successor revision written when reconciliation
      // settles the reminder schedule after persisting this N snapshot.
      revision: overrides.workRevision ?? 8,
      nextActionAt: null,
      executionEpoch: overrides.executionEpoch ?? 3,
      campaignResumeGeneration: overrides.campaignResumeGeneration ?? 4,
    },
    awaitingHuman: overrides.awaitingHuman ?? false,
    extraction: {
      cursorSeq: overrides.cursorSeq ?? 0,
    },
    messages: overrides.messages ?? [],
  };
}

function participant(postEventFeedbackWhatsappOptIn: boolean) {
  return {
    id: "b2c3d4e5-f607-4809-8a1b-2c3d4e5f6071",
    postEventFeedbackWhatsappOptIn,
  };
}

function extractionReplyLog(
  overrides: {
    readonly latestMessageSeq?: number | null;
    readonly participantIngressIds?: readonly string[];
    readonly controlChangedAt?: string;
    readonly workRevision?: number;
    readonly executionEpoch?: number;
    readonly campaignResumeGeneration?: number | null;
  } = {},
) {
  return {
    id: "1cad180a-60bb-4543-8c43-026df5a66060",
    outboxId,
    conversationId,
    campaignId: claimedRow().campaignId,
    origin: "extraction_reply",
    correlationId: "dispatcher-test",
    decision: {
      origin: "extraction_reply",
      model: "test-model",
      confidence: null,
      closingReason: null,
      askedGoal: "event_score",
      venueContextRevision: null,
      goalStatuses: [],
    },
    conversationState: {
      lifecycle: { state: "open", reason: null },
      control: {
        mode: "bot",
        source: "launch",
        changedAt:
          overrides.controlChangedAt ?? snapshotControlChangedAt.toISOString(),
      },
      work: {
        revision: overrides.workRevision ?? 7,
        executionEpoch: overrides.executionEpoch ?? 3,
        campaignResumeGeneration:
          overrides.campaignResumeGeneration === undefined
            ? 4
            : overrides.campaignResumeGeneration,
      },
      awaitingHuman: false,
      needsAttention: false,
      unresolvedAttentionCount: 0,
      goals: [],
      messageCount: overrides.latestMessageSeq === undefined ? 0 : 1,
      latestMessageSeq: overrides.latestMessageSeq ?? null,
      participantIngressIds: [...(overrides.participantIngressIds ?? [])],
      extractionCursorSeq: 0,
      reminderCount: 0,
    },
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
  };
}

function createHarness(
  options: {
    readonly claims?: FeedbackOutboxClaimedRow[];
    readonly control?: "bot" | "human";
  } = {},
) {
  const claims = options.claims ?? [claimedRow()];
  const transaction = {};
  const database = {
    transaction: vi.fn(
      async (work: (transaction: object) => Promise<unknown>) =>
        work(transaction),
    ),
  };
  const repository = {
    lockConversation: vi.fn().mockResolvedValue(undefined),
    findExpiredDispatchAttempts: vi.fn().mockResolvedValue([]),
    quarantineExpiredDispatchAttempt: vi.fn().mockResolvedValue(undefined),
    findStaleLegacySending: vi.fn().mockResolvedValue([]),
    quarantineStaleLegacySending: vi.fn().mockResolvedValue(undefined),
    listTerminalDispatchCandidates: vi.fn().mockResolvedValue([]),
    claimDispatchBatch: vi.fn().mockResolvedValue(claims),
    releaseDispatchClaim: vi.fn().mockResolvedValue({ status: "pending" }),
    renewDispatchClaim: vi.fn().mockResolvedValue({ status: "claimed" }),
    finishDispatchClaimBeforeAttempt: vi
      .fn()
      .mockResolvedValue({ status: "cancelled" }),
    markDispatchAttemptStarted: vi
      .fn()
      .mockImplementation(async (id, token) =>
        attemptingRow({ ...claims[0]!, id, claimToken: token }),
      ),
    markDispatchSent: vi.fn().mockResolvedValue({ status: "sent" }),
    markDispatchFailed: vi.fn().mockResolvedValue({ status: "failed" }),
    markDispatchAmbiguous: vi.fn().mockImplementation(async (id, token) => ({
      ...attemptingRow({ ...claims[0]!, id, claimToken: token }),
      status: "ambiguous",
      claimExpiresAt: null,
    })),
    cancelQueuedAutomatedOutboxForConversation: vi.fn().mockResolvedValue(0),
  };
  const ingress = {
    lockInboundPhone: vi.fn().mockResolvedValue(undefined),
    hasInboundBeyondSnapshot: vi.fn().mockResolvedValue(false),
  };
  const outboundLogs = {
    findLogByOutboxId: vi.fn().mockResolvedValue(extractionReplyLog()),
  };
  const campaigns = {
    findCampaignById: vi.fn().mockResolvedValue({ status: "launched" }),
    findCampaignByIdForShare: vi.fn().mockResolvedValue({ status: "launched" }),
  };
  const conversations = {
    findById: vi.fn().mockResolvedValue(conversation(options.control ?? "bot")),
    listCurrentTerminalOutboxIds: vi.fn().mockResolvedValue([]),
    markAwaitingHuman: vi.fn().mockResolvedValue({ changed: true }),
    raiseAttention: vi.fn().mockResolvedValue({ changed: true }),
  };
  const participants = {
    findById: vi.fn().mockResolvedValue(participant(true)),
    findByIdForUpdate: vi.fn().mockResolvedValue(participant(true)),
  };
  const outboundTranscript = {
    record: vi.fn().mockResolvedValue({
      outcome: "appended",
      conversation: conversation(options.control ?? "bot"),
    }),
  };
  const transport = {
    sendText: vi.fn().mockResolvedValue({
      outcome: "accepted",
      providerLogId: "42",
      providerMessageId: "wamid.1",
      providerStatus: "sent",
    }),
  };
  const limiter = {
    waitTurn: vi.fn().mockResolvedValue({ waitedMs: 0 }),
  };

  const harness = {
    database,
    transaction,
    repository,
    ingress,
    outboundLogs,
    campaigns,
    conversations,
    participants,
    outboundTranscript,
    transport,
    limiter,
  };
  return {
    ...harness,
    service: createServiceFromHarness(harness),
  };
}

function createServiceFromHarness(harness: {
  readonly database: object;
  readonly campaigns: object;
  readonly repository: object;
  readonly ingress: object;
  readonly outboundLogs: object;
  readonly conversations: object;
  readonly participants: object;
  readonly outboundTranscript: object;
  readonly transport: object;
  readonly limiter: object;
}): MessageOutboxDispatcherService {
  return new MessageOutboxDispatcherService(
    harness.database as unknown as DatabaseService,
    harness.campaigns as unknown as FeedbackCampaignRepository,
    harness.repository as unknown as FeedbackOutboxRepository,
    harness.ingress as unknown as FeedbackIngressRepository,
    harness.outboundLogs as unknown as FeedbackOutboundLogRepository,
    harness.conversations as unknown as FeedbackConversationRepository,
    harness.participants as unknown as ParticipantsRepository,
    harness.outboundTranscript as unknown as FeedbackOutboundTranscriptService,
    harness.transport as unknown as FeedbackTransport,
    harness.limiter as unknown as FeedbackSendLimiter,
  );
}
