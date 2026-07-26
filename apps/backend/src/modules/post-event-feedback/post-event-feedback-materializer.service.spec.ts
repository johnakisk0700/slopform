import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import type { Queue } from "bullmq";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import { buildFeedbackConversationGoals } from "../conversations/feedback-conversation.schemas.js";
import type { ParticipantsRepository } from "../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeParticipants,
  FakeQueue,
} from "./post-event-feedback-doubles.harness.js";
import { PostEventFeedbackMaterializer } from "./post-event-feedback-materializer.service.js";
import { PostEventFeedbackMetrics } from "./post-event-feedback-metrics.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./post-event-feedback-question-set.js";
import type { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const phone = "+306900000000";
const chatJid = "306900000000@s.whatsapp.net";
const observedAt = new Date("2026-07-25T10:05:00.000Z");
const correlationId = "correlation-1";

describe("PostEventFeedbackMaterializer", () => {
  let harness: Harness;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    harness = createHarness();
  });

  it("keeps unmatched traffic unattributed but no longer deletes what it said", async () => {
    harness.conversations.documents.clear();
    const ingressId = harness.repository.seedIngress({
      text: "Καλησπέρα, θέλω κράτηση για αύριο",
    });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("ignored_unmatched");
    expect(harness.repository.ingress.get(ingressId)).toMatchObject({
      processingStatus: "ignored_unmatched",
      // D10 as amended: still linked to no conversation, so nothing here is
      // attributed to a participant — but the words survive, because the same
      // path receives «σόρρυ άλλαξα νούμερο» from a real respondent.
      text: "Καλησπέρα, θέλω κράτηση για αύριο",
      matchedConversationId: null,
      chatJid,
    });
    expect(harness.metrics.count("ignored_unmatched")).toBe(1);
    expect(harness.queue.added).toHaveLength(0);
    expect(harness.audit.events).toHaveLength(0);
  });

  it("materializes a participant reply and queues exactly one extraction run", async () => {
    const ingressId = harness.repository.seedIngress({ text: "Ήταν τέλεια!" });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result).toMatchObject({
      outcome: "inbound_materialized",
      conversationId,
      extractJobId: `feedback-extract-v1-${conversationId}-1`,
    });
    expect(harness.conversations.transcript(conversationId)).toEqual([
      {
        seq: 1,
        actor: "participant",
        text: "Ήταν τέλεια!",
        ingressId,
        outboxId: null,
      },
    ]);
    expect(harness.repository.ingress.get(ingressId)).toMatchObject({
      processingStatus: "materialized",
      matchedConversationId: conversationId,
    });
    // The quiet window is part of the enqueue contract, not an incidental
    // option: without it the run opens on the first fragment of a typed thought.
    expect(harness.queue.added).toEqual([
      {
        name: "feedback.extract.v1",
        data: { schemaVersion: 1, conversationId, correlationId },
        jobId: `feedback-extract-v1-${conversationId}-1`,
        delay: FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
      },
    ]);
  });

  it("replays a duplicate delivery without duplicating transcript or jobs", async () => {
    const ingressId = harness.repository.seedIngress({ text: "Ήταν τέλεια!" });

    await harness.materializer.materialize({ ingressId, correlationId });
    const replay = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(replay.outcome).toBe("already_processed");
    expect(harness.conversations.transcript(conversationId)).toHaveLength(1);
    expect(harness.queue.added).toHaveLength(1);
    expect(harness.metrics.count("already_processed")).toBe(1);
  });

  it("serializes concurrent executions of the same job on the ingress fence", async () => {
    const ingressId = harness.repository.seedIngress({ text: "Ήταν τέλεια!" });

    const outcomes = await Promise.all([
      harness.materializer.materialize({ ingressId, correlationId }),
      harness.materializer.materialize({ ingressId, correlationId }),
    ]);

    expect(outcomes.map((result) => result.outcome)).toEqual([
      "inbound_materialized",
      "inbound_materialized",
    ]);
    expect(harness.conversations.transcript(conversationId)).toHaveLength(1);
    expect(harness.queue.added).toHaveLength(1);
    expect(harness.repository.ingress.get(ingressId)?.processingStatus).toBe(
      "materialized",
    );
  });

  it("materializes out-of-order arrivals in durable arrival order", async () => {
    const later = harness.repository.seedIngress({
      text: "Και ο Κώστας ήταν τέλειος",
      observedAt: new Date("2026-07-25T10:07:00.000Z"),
      providerMessageId: "provider-message-2",
    });
    const earlier = harness.repository.seedIngress({
      text: "Πέρασα πολύ ωραία",
      observedAt: new Date("2026-07-25T10:06:00.000Z"),
      providerMessageId: "provider-message-1",
    });

    await harness.materializer.materialize({
      ingressId: later,
      correlationId,
    });
    await harness.materializer.materialize({
      ingressId: earlier,
      correlationId,
    });

    expect(
      harness.conversations.transcript(conversationId).map((m) => m.text),
    ).toEqual(["Και ο Κώστας ήταν τέλειος", "Πέρασα πολύ ωραία"]);
    expect(harness.queue.added.map((job) => job.jobId)).toEqual([
      `feedback-extract-v1-${conversationId}-1`,
      `feedback-extract-v1-${conversationId}-2`,
    ]);
  });

  it("applies STOP before any extraction and closes the conversation for good", async () => {
    harness.repository.seedOutbox({ kind: "reminder", body: "Καλημέρα!" });
    const ingressId = harness.repository.seedIngress({ text: " Στοπ " });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("inbound_stopped");
    expect(harness.conversations.get(conversationId).lifecycle).toMatchObject({
      state: "closed",
      reason: "stopped",
    });
    expect(harness.repository.outbox.map((row) => row.status)).toEqual([
      "cancelled",
      "pending",
    ]);
    expect(harness.repository.outbox[1]).toMatchObject({
      kind: "system",
      body: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.stop_ack,
      dedupeKey: `feedback-stop-ack-${conversationId}`,
    });
    expect(
      harness.participants.rows.get(respondentParticipantId)
        ?.postEventFeedbackWhatsappOptIn,
    ).toBe(false);
    expect(harness.audit.events.map((event) => event.action)).toEqual([
      "participant.feedback_whatsapp_opt_in_changed",
      "feedback_conversation.stopped",
    ]);
    expect(harness.queue.added).toHaveLength(0);
  });

  it("uses the campaign launch copy for the acknowledgement when present", async () => {
    harness.repository.campaigns.set(campaignId, {
      id: campaignId,
      questions: { copy: { stop_ack: "Έγινε, σε διαγράψαμε." } },
    });
    const ingressId = harness.repository.seedIngress({ text: "ΔΙΑΚΟΠΗ" });

    await harness.materializer.materialize({ ingressId, correlationId });

    expect(harness.repository.outbox[0]?.body).toBe("Έγινε, σε διαγράψαμε.");
  });

  it("applies STOP while a human operator holds control", async () => {
    harness.conversations.get(conversationId).control = {
      mode: "human",
      source: "staff_action",
      changedAt: observedAt,
    };
    const ingressId = harness.repository.seedIngress({ text: "unsubscribe" });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("inbound_stopped");
    expect(harness.conversations.get(conversationId).lifecycle).toMatchObject({
      state: "closed",
      reason: "stopped",
    });
    expect(harness.conversations.get(conversationId).control.mode).toBe(
      "human",
    );
    expect(
      harness.repository.outbox.filter((row) => row.kind === "system"),
    ).toHaveLength(1);
  });

  it("never sends a second acknowledgement when a STOP delivery is replayed", async () => {
    const ingressId = harness.repository.seedIngress({ text: "STOP" });

    await harness.materializer.materialize({ ingressId, correlationId });
    await harness.materializer.materialize({ ingressId, correlationId });

    expect(harness.repository.outbox).toHaveLength(1);
    expect(harness.audit.events).toHaveLength(2);
    // The participant's STOP and exactly one acknowledgement — the replay
    // re-appends neither, because both are idempotent by their provenance.
    const transcript = harness.conversations.transcript(conversationId);
    expect(transcript).toHaveLength(2);
    expect(transcript[1]).toMatchObject({
      actor: "bot",
      outboxId: harness.repository.outbox[0]?.id,
    });
  });

  it("records the STOP acknowledgement in the transcript as a bot turn", async () => {
    const ingressId = harness.repository.seedIngress({ text: "STOP" });

    await harness.materializer.materialize({ ingressId, correlationId });

    const acknowledgement = harness.repository.outbox.find(
      (row) => row.kind === "system",
    );
    expect(acknowledgement).toBeDefined();
    // `actor: system` is reserved for entries without transport provenance, so
    // an outbox-backed acknowledgement is the bot speaking.
    expect(
      harness.conversations.transcript(conversationId).at(-1),
    ).toMatchObject({
      actor: "bot",
      text: acknowledgement?.body,
      outboxId: acknowledgement?.id,
    });
  });

  describe("model-only safety classification", () => {
    const disclosure = "Ο Γιώργος μας έδειχνε dickpics όλο το βράδυ";

    it("materializes testimony without classifying it from keywords", async () => {
      const ingressId = harness.repository.seedIngress({ text: disclosure });

      const result = await harness.materializer.materialize({
        ingressId,
        correlationId,
      });

      expect(result).toMatchObject({
        outcome: "inbound_materialized",
        conversationId,
        extractJobId: `feedback-extract-v1-${conversationId}-1`,
      });
      expect(harness.queue.added).toHaveLength(1);
      expect(harness.conversations.transcript(conversationId)).toMatchObject([
        {
          seq: 1,
          actor: "participant",
          text: disclosure,
        },
      ]);
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        false,
      );
      expect(harness.audit.events).toHaveLength(0);
      expect(harness.repository.outbox).toHaveLength(0);
    });
  });

  it("correlates an observed outbound to its outbox row without touching the transcript", async () => {
    const outboxId = harness.repository.seedOutbox({
      kind: "intro",
      body: "Γεια σου Ρούλα!",
      status: "sending",
    });
    const ingressId = harness.repository.seedIngress({
      direction: "outbound",
      text: "Γεια σου Ρούλα!",
    });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result).toMatchObject({
      outcome: "outbound_correlated",
      correlatedOutboxId: outboxId,
    });
    expect(harness.repository.outbox[0]).toMatchObject({
      status: "sent",
      deliveryStatus: "sent",
      providerMessageId: "provider-message-1",
      sentAt: observedAt,
    });
    expect(harness.conversations.transcript(conversationId)).toHaveLength(0);
    expect(harness.conversations.get(conversationId).control.mode).toBe("bot");
  });

  it("does not downgrade a delivery status that already advanced", async () => {
    harness.repository.seedOutbox({
      kind: "intro",
      body: "Γεια σου Ρούλα!",
      status: "sent",
      providerMessageId: "provider-message-1",
      deliveryStatus: "read",
    });
    const ingressId = harness.repository.seedIngress({
      direction: "outbound",
      text: "Γεια σου Ρούλα!",
    });

    await harness.materializer.materialize({ ingressId, correlationId });

    expect(harness.repository.outbox[0]?.deliveryStatus).toBe("read");
  });

  it("still correlates a delivery for a conversation that already closed", async () => {
    // The STOP acknowledgement is sent after closure, so its observation finds
    // no open conversation. It is our own message, not unrelated traffic.
    harness.repository.seedOutbox({
      kind: "system",
      body: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.stop_ack,
      status: "sending",
      providerMessageId: "provider-message-1",
    });
    harness.conversations.get(conversationId).lifecycle = {
      state: "closed",
      reason: "stopped",
      closedAt: observedAt,
    };
    const ingressId = harness.repository.seedIngress({
      direction: "outbound",
      text: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.stop_ack,
    });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("outbound_correlated");
    expect(harness.repository.outbox[0]).toMatchObject({
      status: "sent",
      deliveryStatus: "sent",
    });
    expect(harness.metrics.count("ignored_unmatched")).toBe(0);
    expect(harness.repository.ingress.get(ingressId)).toMatchObject({
      processingStatus: "materialized",
      matchedConversationId: conversationId,
    });
  });

  it("ignores an outbound to a closed conversation that is not ours", async () => {
    harness.conversations.get(conversationId).lifecycle = {
      state: "closed",
      reason: "stopped",
      closedAt: observedAt,
    };
    const ingressId = harness.repository.seedIngress({
      direction: "outbound",
      text: "άσχετο μήνυμα",
    });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("ignored_unmatched");
    // Unattributed, not erased: the row links to no conversation.
    expect(
      harness.repository.ingress.get(ingressId)?.matchedConversationId,
    ).toBeNull();
  });

  it("treats an uncorrelated outbound as external channel activity", async () => {
    const ingressId = harness.repository.seedIngress({
      direction: "outbound",
      text: "Γεια σου, σου τηλεφωνώ αύριο",
    });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("outbound_external");
    expect(harness.conversations.get(conversationId).control).toMatchObject({
      mode: "human",
      source: "external_outbound",
    });
    expect(harness.conversations.transcript(conversationId)).toEqual([
      {
        seq: 1,
        actor: "staff",
        text: "Γεια σου, σου τηλεφωνώ αύριο",
        ingressId,
        outboxId: null,
      },
    ]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: "feedback_conversation.external_outbound_observed",
        entityId: conversationId,
      }),
    ]);
  });

  it("flags an inbound without usable text instead of dropping it", async () => {
    const ingressId = harness.repository.seedIngress({ text: null });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("inbound_not_materialized");
    expect(harness.repository.ingress.get(ingressId)?.processingStatus).toBe(
      "failed",
    );
    expect(harness.conversations.get(conversationId).needsAttention).toBe(true);
    expect(harness.queue.added).toHaveLength(0);
  });

  it("refuses to reprocess a terminal ingress row", async () => {
    const ingressId = harness.repository.seedIngress({
      text: "Ήταν τέλεια!",
      processingStatus: "ignored_unmatched",
    });

    const result = await harness.materializer.materialize({
      ingressId,
      correlationId,
    });

    expect(result.outcome).toBe("already_processed");
    expect(harness.conversations.transcript(conversationId)).toHaveLength(0);
  });

  it("does not retry a job whose ingress row is gone", async () => {
    await expect(
      harness.materializer.materialize({
        ingressId: randomUUID(),
        correlationId,
      }),
    ).rejects.toThrow(/was not found/u);
  });
});

interface FakeIngressRow {
  id: string;
  providerMessageId: string;
  chatJid: string;
  direction: "inbound" | "outbound";
  phoneE164: string | null;
  text: string | null;
  observedAt: Date;
  processingStatus: string;
  matchedConversationId: string | null;
}

interface FakeOutboxRow {
  id: string;
  conversationId: string;
  campaignId: string;
  kind: string;
  body: string;
  status: string;
  dedupeKey: string;
  providerMessageId: string | null;
  deliveryStatus: string | null;
  sentAt: Date | null;
}

interface FakeMessage {
  id: string;
  seq: number;
  actor: string;
  text: string;
  providerMessageId: string | null;
  ingressId: string | null;
  outboxId: string | null;
  attention?: {
    categories: string[];
    recommendedAction: string;
    confidence: number;
  } | null;
  at: Date;
}

interface FakeConversation {
  _id: string;
  campaignId: string;
  respondentParticipantId: string;
  phoneAtLaunch: string;
  lifecycle: { state: string; reason: string | null; closedAt: Date | null };
  control: { mode: string; source: string; changedAt: Date };
  goals: { key: string; ordinal: number; prompt: string; status: string }[];
  messages: FakeMessage[];
  needsAttention: boolean;
}

class FakeFeedbackRepository {
  readonly ingress = new Map<string, FakeIngressRow>();
  readonly outbox: FakeOutboxRow[] = [];
  readonly campaigns = new Map<
    string,
    { id: string; questions: Record<string, unknown> }
  >();
  private providerMessageSequence = 0;

  seedIngress(
    overrides: Partial<FakeIngressRow> & { text: string | null },
  ): string {
    this.providerMessageSequence += 1;
    const row: FakeIngressRow = {
      id: randomUUID(),
      providerMessageId: `provider-message-${this.providerMessageSequence}`,
      chatJid,
      direction: "inbound",
      phoneE164: phone,
      observedAt,
      processingStatus: "pending",
      matchedConversationId: null,
      ...overrides,
    };
    this.ingress.set(row.id, row);
    return row.id;
  }

  seedOutbox(overrides: Partial<FakeOutboxRow> & { body: string }): string {
    const row: FakeOutboxRow = {
      id: randomUUID(),
      conversationId,
      campaignId,
      kind: "reply",
      status: "pending",
      dedupeKey: `seeded-${this.outbox.length}`,
      providerMessageId: null,
      deliveryStatus: null,
      sentAt: null,
      ...overrides,
    };
    this.outbox.push(row);
    return row.id;
  }

  async findIngressById(id: string): Promise<FakeIngressRow | undefined> {
    return structuredCloneRow(this.ingress.get(id));
  }

  async findIngressByIdForUpdate(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FakeIngressRow | undefined> {
    return structuredCloneRow(this.ingress.get(id));
  }

  async updateIngressProcessing(
    _transaction: AppTransaction,
    id: string,
    input: {
      processingStatus: string;
      matchedConversationId?: string | null;
      text?: string | null;
    },
  ): Promise<FakeIngressRow | undefined> {
    const row = this.ingress.get(id);
    if (!row) {
      return undefined;
    }
    row.processingStatus = input.processingStatus;
    if (input.matchedConversationId !== undefined) {
      row.matchedConversationId = input.matchedConversationId;
    }
    if (input.text !== undefined) {
      row.text = input.text;
    }
    return structuredCloneRow(row);
  }

  async cancelQueuedOutboxForConversation(
    _transaction: AppTransaction,
    id: string,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.conversationId === id &&
        (row.status === "pending" || row.status === "held")
      ) {
        row.status = "cancelled";
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async findCampaignById(
    id: string,
  ): Promise<{ id: string; questions: Record<string, unknown> } | undefined> {
    return this.campaigns.get(id);
  }

  async insertOutboxIfAbsent(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      campaignId: string;
      kind: string;
      body: string;
      dedupeKey: string;
    },
  ): Promise<{ row: FakeOutboxRow; inserted: boolean }> {
    const existing = this.outbox.find(
      (row) => row.dedupeKey === input.dedupeKey,
    );
    if (existing) {
      return { row: structuredCloneRow(existing)!, inserted: false };
    }
    const row: FakeOutboxRow = {
      id: randomUUID(),
      status: "pending",
      providerMessageId: null,
      deliveryStatus: null,
      sentAt: null,
      ...input,
    };
    this.outbox.push(row);
    return { row: structuredCloneRow(row)!, inserted: true };
  }

  async updateOutboxStatus(
    _transaction: AppTransaction,
    id: string,
    status: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (row) {
      row.status = status;
    }
    return structuredCloneRow(row);
  }

  async findOutboxByProviderMessageId(
    providerMessageId: string,
  ): Promise<FakeOutboxRow | undefined> {
    return structuredCloneRow(
      this.outbox.find((row) => row.providerMessageId === providerMessageId),
    );
  }

  async findUnlinkedOutboxByConversationAndBody(
    id: string,
    body: string,
  ): Promise<FakeOutboxRow | undefined> {
    return structuredCloneRow(
      this.outbox.find(
        (row) =>
          row.conversationId === id &&
          row.body === body &&
          !row.providerMessageId &&
          ["pending", "sending", "sent"].includes(row.status),
      ),
    );
  }

  async updateOutboxDelivery(
    _transaction: AppTransaction,
    id: string,
    input: {
      deliveryStatus: string;
      providerMessageId?: string | null;
      sentAt?: Date | null;
      status?: string;
    },
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (!row) {
      return undefined;
    }
    row.deliveryStatus = input.deliveryStatus;
    if (input.providerMessageId !== undefined) {
      row.providerMessageId = input.providerMessageId;
    }
    if (input.sentAt !== undefined) {
      row.sentAt = input.sentAt;
    }
    if (input.status !== undefined) {
      row.status = input.status;
    }
    return structuredCloneRow(row);
  }
}

/**
 * Mirrors the documented schema-v2 repository contract: idempotent appends by
 * provenance, first-closure-wins with a STOP override, and takeover only from
 * bot control. The Mongo implementation itself is covered by its own spec.
 */
class FakeConversations {
  readonly documents = new Map<string, FakeConversation>();

  seed(conversation: FakeConversation): void {
    this.documents.set(conversation._id, conversation);
  }

  get(id: string): FakeConversation {
    const conversation = this.documents.get(id);
    if (!conversation) {
      throw new Error(`Conversation ${id} was not seeded`);
    }
    return conversation;
  }

  transcript(id: string): {
    seq: number;
    actor: string;
    text: string;
    ingressId: string | null;
    outboxId: string | null;
    attention: FakeMessage["attention"];
  }[] {
    return this.get(id).messages.map((message) => ({
      seq: message.seq,
      actor: message.actor,
      text: message.text,
      ingressId: message.ingressId,
      outboxId: message.outboxId,
      attention: message.attention,
    }));
  }

  async findOpenByPhone(
    phoneAtLaunch: string,
  ): Promise<FakeConversation | undefined> {
    return [...this.documents.values()].find(
      (conversation) =>
        conversation.phoneAtLaunch === phoneAtLaunch &&
        conversation.lifecycle.state === "open",
    );
  }

  async findLatestClosedByPhone(
    phoneAtLaunch: string,
  ): Promise<FakeConversation | undefined> {
    return [...this.documents.values()]
      .reverse()
      .find(
        (conversation) =>
          conversation.phoneAtLaunch === phoneAtLaunch &&
          conversation.lifecycle.state === "closed",
      );
  }

  async appendMessage(input: {
    conversationId: string;
    actor: string;
    text: string;
    at: Date;
    id?: string;
    providerMessageId?: string | null;
    ingressId?: string | null;
    outboxId?: string | null;
  }): Promise<{
    appended: boolean;
    message: FakeMessage;
    conversation: FakeConversation;
  }> {
    const conversation = this.get(input.conversationId);
    const keys = [input.id, input.ingressId, input.outboxId].filter(Boolean);
    const existing = conversation.messages.find((message) =>
      [message.id, message.ingressId, message.outboxId]
        .filter(Boolean)
        .some((key) => keys.includes(key as string)),
    );
    if (existing) {
      return { appended: false, message: existing, conversation };
    }

    const message: FakeMessage = {
      id: input.id ?? randomUUID(),
      seq: conversation.messages.length + 1,
      actor: input.actor,
      text: input.text.trim(),
      providerMessageId: input.providerMessageId ?? null,
      ingressId: input.ingressId ?? null,
      outboxId: input.outboxId ?? null,
      at: input.at,
    };
    conversation.messages.push(message);
    return { appended: true, message, conversation };
  }

  async close(input: {
    conversationId: string;
    reason: string;
    at: Date;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const closable =
      conversation.lifecycle.state === "open" ||
      (input.reason === "stopped" &&
        conversation.lifecycle.reason !== "stopped");
    if (!closable) {
      return { changed: false, conversation };
    }
    conversation.lifecycle = {
      state: "closed",
      reason: input.reason,
      closedAt: input.at,
    };
    return { changed: true, conversation };
  }

  async takeOver(input: {
    conversationId: string;
    source: string;
    at: Date;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    if (conversation.control.mode === "human") {
      return { changed: false, conversation };
    }
    conversation.control = {
      mode: "human",
      source: input.source,
      changedAt: input.at,
    };
    return { changed: true, conversation };
  }

  async setNeedsAttention(input: {
    conversationId: string;
    needsAttention: boolean;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const changed = conversation.needsAttention !== input.needsAttention;
    conversation.needsAttention = input.needsAttention;
    return { changed, conversation };
  }
}

interface Harness {
  materializer: PostEventFeedbackMaterializer;
  repository: FakeFeedbackRepository;
  conversations: FakeConversations;
  participants: FakeParticipants;
  audit: FakeAudit;
  queue: FakeQueue;
  metrics: PostEventFeedbackMetrics;
}

function createHarness(): Harness {
  const repository = new FakeFeedbackRepository();
  const conversations = new FakeConversations();
  const participants = new FakeParticipants();
  const audit = new FakeAudit();
  const queue = new FakeQueue();
  const metrics = new PostEventFeedbackMetrics();

  conversations.seed({
    _id: conversationId,
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: phone,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: {
      mode: "bot",
      source: "launch",
      changedAt: new Date("2026-07-25T10:00:00.000Z"),
    },
    goals: buildFeedbackConversationGoals(),
    messages: [],
    needsAttention: false,
  });
  participants.rows.set(respondentParticipantId, {
    id: respondentParticipantId,
    preferredName: null,
    emailNormalized: `${respondentParticipantId}@example.test`,
    phoneE164: phone,
    postEventFeedbackWhatsappOptIn: true,
  });

  const database = new FakeDatabase();
  const materializer = new PostEventFeedbackMaterializer(
    queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
    database as unknown as DatabaseService,
    repository as unknown as PostEventFeedbackRepository,
    conversations as unknown as FeedbackConversationRepository,
    participants as unknown as ParticipantsRepository,
    audit as unknown as AuditRepository,
    metrics,
    new FeedbackOutboundTranscriptService(
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
    ),
  );

  return {
    materializer,
    repository,
    conversations,
    participants,
    audit,
    queue,
    metrics,
  };
}

function structuredCloneRow<T>(row: T | undefined): T | undefined {
  return row ? { ...row } : undefined;
}
