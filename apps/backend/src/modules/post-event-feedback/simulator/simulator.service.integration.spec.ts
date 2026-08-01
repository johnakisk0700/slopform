import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import type { Queue } from "bullmq";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import type { FeedbackOutboundLogRepository } from "../outbox/outbound-log.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { FeedbackSimulatorService } from "./simulator.service.js";
import { MessageOutboxDeliveryService } from "../outbox/deliver.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeParticipants,
  FakeQueue,
} from "../post-event-feedback-doubles.harness.js";
import { PostEventFeedbackIngressService } from "../ingress/ingress.service.js";
import { PostEventFeedbackMaterializer } from "../ingress/materialize.service.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "../extraction/results.repository.js";
import type { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import type { FeedbackSimOutboundRepository } from "./sim-outbound.repository.js";
import type { FeedbackJobData, FeedbackJobName } from "../jobs.schemas.js";
import { SimulatedFeedbackTransport } from "../outbox/simulated-transport.service.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const phone = "+306900000000";
const chatJid = "306900000000@s.whatsapp.net";
const observedAt = new Date("2026-07-25T10:05:00.000Z");

describe("post-event feedback simulator (simulated mode)", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let harness: SimulatorHarness;

  beforeEach(() => {
    harness = createSimulatorHarness();
  });

  it("runs intro delivery → inject reply → materialize → extract enqueue", async () => {
    const introOutboxId = harness.repository.seedOutbox({
      kind: "intro",
      body: "Γεια σου! Πώς ήταν η εκδήλωση;",
      status: "sending",
      dedupeKey: "intro:1",
    });

    await expect(
      harness.delivery.deliver(introOutboxId, "corr-intro"),
    ).resolves.toEqual({ outcome: "sent" });
    expect(harness.repository.simOutbound).toHaveLength(1);
    expect(harness.repository.simOutbound[0]?.phoneE164).toBe(phone);

    const inject = await harness.simulator.injectObservedMessage(
      { phoneE164: phone, text: "Ήταν τέλεια!", fromMe: false },
      "corr-inject",
    );

    const materialize = await harness.materializer.materialize({
      ingressId: inject.ingressId,
      correlationId: "corr-materialize",
    });

    // The intro now occupies seq 1, so the participant's reply lands at seq 2.
    expect(materialize).toMatchObject({
      outcome: "inbound_materialized",
      conversationId,
      extractJobId: `feedback-extract-v1-${conversationId}-2`,
    });
    expect(harness.queue.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "feedback.extract.v1",
          jobId: `feedback-extract-v1-${conversationId}-2`,
        }),
      ]),
    );
    expect(
      harness.queue.added.filter((job) => job.name === "feedback.extract.v1"),
    ).toHaveLength(1);
    // The regression this covers: the transcript used to hold only the
    // participant side, so the admin pane and the extraction prompt never saw
    // a bot turn.
    expect(harness.conversations.transcript(conversationId)).toEqual([
      {
        seq: 1,
        actor: "bot",
        text: "Γεια σου! Πώς ήταν η εκδήλωση;",
        ingressId: null,
        outboxId: introOutboxId,
      },
      {
        seq: 2,
        actor: "participant",
        text: "Ήταν τέλεια!",
        ingressId: inject.ingressId,
        outboxId: null,
      },
    ]);
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
  providerLogId: string | null;
  providerMessageId: string | null;
  deliveryStatus: string | null;
  sentAt: Date | null;
}

interface FakeSimOutboundRow {
  id: string;
  outboxId: string;
  phoneE164: string;
  body: string;
  providerMessageId: string;
  sentAt: Date;
}

interface FakeMessage {
  id: string;
  seq: number;
  actor: string;
  text: string;
  ingressId: string | null;
  outboxId?: string | null;
}

interface FakeConversation {
  _id: string;
  campaignId: string;
  respondentParticipantId: string;
  phoneAtLaunch: string;
  lifecycle: { state: string; reason: string | null; closedAt: Date | null };
  control: { mode: string; source: string; changedAt: Date };
  messages: FakeMessage[];
  needsAttention: boolean;
}

class FakeSimulatorRepository {
  readonly ingress = new Map<string, FakeIngressRow>();
  readonly outbox: FakeOutboxRow[] = [];
  readonly simOutbound: FakeSimOutboundRow[] = [];

  seedOutbox(overrides: Partial<FakeOutboxRow> & { body: string }): string {
    const row: FakeOutboxRow = {
      id: randomUUID(),
      conversationId,
      campaignId,
      kind: "reply",
      status: "pending",
      dedupeKey: `seeded-${this.outbox.length}`,
      providerLogId: null,
      providerMessageId: null,
      deliveryStatus: null,
      sentAt: null,
      ...overrides,
    };
    this.outbox.push(row);
    return row.id;
  }

  async findOutboxById(id: string): Promise<FakeOutboxRow | undefined> {
    return structuredClone(this.outbox.find((row) => row.id === id));
  }

  async findCampaignById(id: string) {
    return id === campaignId
      ? { id: campaignId, status: "launched" }
      : undefined;
  }

  async releaseOutboxLease(id: string): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (!row || row.status !== "sending") {
      return undefined;
    }
    row.status = "pending";
    return structuredClone(row);
  }

  async insertIngressIfAbsent(
    _transaction: AppTransaction,
    input: {
      providerMessageId: string;
      chatJid: string;
      direction: "inbound" | "outbound";
      phoneE164?: string | null;
      text?: string | null;
      observedAt: Date;
    },
  ): Promise<{ row: FakeIngressRow; inserted: boolean }> {
    const existing = [...this.ingress.values()].find(
      (row) =>
        row.chatJid === input.chatJid &&
        row.providerMessageId === input.providerMessageId,
    );
    if (existing) {
      return { row: structuredClone(existing), inserted: false };
    }
    const row: FakeIngressRow = {
      id: randomUUID(),
      providerMessageId: input.providerMessageId,
      chatJid: input.chatJid,
      direction: input.direction,
      phoneE164: input.phoneE164 ?? null,
      text: input.text ?? null,
      observedAt: input.observedAt,
      processingStatus: "pending",
      matchedConversationId: null,
    };
    this.ingress.set(row.id, row);
    return { row: structuredClone(row), inserted: true };
  }

  async insertSimOutbound(input: {
    id?: string;
    outboxId: string;
    phoneE164: string;
    body: string;
    providerMessageId: string;
    sentAt: Date;
  }): Promise<FakeSimOutboundRow> {
    const row: FakeSimOutboundRow = {
      id: input.id ?? randomUUID(),
      outboxId: input.outboxId,
      phoneE164: input.phoneE164,
      body: input.body,
      providerMessageId: input.providerMessageId,
      sentAt: input.sentAt,
    };
    this.simOutbound.push(row);
    return row;
  }

  async findSimOutboundById(
    id: string,
  ): Promise<FakeSimOutboundRow | undefined> {
    return structuredClone(this.simOutbound.find((row) => row.id === id));
  }

  async listIngressByPhoneE164(phoneE164: string): Promise<FakeIngressRow[]> {
    return [...this.ingress.values()]
      .filter((row) => row.phoneE164 === phoneE164)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  }

  async listSimOutboundByPhoneE164(
    phoneE164: string,
  ): Promise<FakeSimOutboundRow[]> {
    return this.simOutbound
      .filter((row) => row.phoneE164 === phoneE164)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  async findIngressById(id: string): Promise<FakeIngressRow | undefined> {
    const row = this.ingress.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async findIngressByIdForUpdate(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FakeIngressRow | undefined> {
    return this.findIngressById(id);
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
    return structuredClone(row);
  }

  async updateOutboxDelivery(
    _transaction: AppTransaction,
    id: string,
    input: {
      status?: string;
      deliveryStatus?: string | null;
      providerLogId?: string | null;
      providerMessageId?: string | null;
      sentAt?: Date | null;
    },
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (!row) {
      return undefined;
    }
    if (input.status !== undefined) {
      row.status = input.status;
    }
    if (input.deliveryStatus !== undefined) {
      row.deliveryStatus = input.deliveryStatus;
    }
    if (input.providerLogId !== undefined) {
      row.providerLogId = input.providerLogId;
    }
    if (input.providerMessageId !== undefined) {
      row.providerMessageId = input.providerMessageId;
    }
    if (input.sentAt !== undefined) {
      row.sentAt = input.sentAt;
    }
    return structuredClone(row);
  }
}

class FakeConversations {
  readonly documents = new Map<string, FakeConversation>();

  seed(conversation: FakeConversation): void {
    this.documents.set(conversation._id, conversation);
  }

  transcript(id: string): {
    seq: number;
    actor: string;
    text: string;
    ingressId: string | null;
    outboxId: string | null;
  }[] {
    const conversation = this.documents.get(id);
    if (!conversation) {
      throw new Error(`Conversation ${id} was not seeded`);
    }
    return conversation.messages.map((message) => ({
      seq: message.seq,
      actor: message.actor,
      text: message.text,
      ingressId: message.ingressId,
      outboxId: message.outboxId ?? null,
    }));
  }

  async findById(id: string): Promise<FakeConversation | undefined> {
    const conversation = this.documents.get(id);
    return conversation ? structuredClone(conversation) : undefined;
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

  /** Idempotent by `ingressId` / `outboxId`, like the real repository. */
  async appendMessage(input: {
    conversationId: string;
    actor: string;
    text: string;
    at: Date;
    ingressId?: string | null;
    outboxId?: string | null;
  }): Promise<{
    appended: boolean;
    message: FakeMessage;
    conversation: FakeConversation;
  }> {
    const conversation = this.documents.get(input.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${input.conversationId} was not seeded`);
    }
    const keys = [input.ingressId, input.outboxId].filter(Boolean);
    const existing = conversation.messages.find((message) =>
      [message.ingressId, message.outboxId]
        .filter(Boolean)
        .some((key) => keys.includes(key as string)),
    );
    if (existing) {
      return { appended: false, message: existing, conversation };
    }
    const message: FakeMessage = {
      id: randomUUID(),
      seq: conversation.messages.length + 1,
      actor: input.actor,
      text: input.text,
      ingressId: input.ingressId ?? null,
      outboxId: input.outboxId ?? null,
    };
    conversation.messages.push(message);
    return { appended: true, message, conversation };
  }
}

interface SimulatorHarness {
  repository: FakeSimulatorRepository;
  conversations: FakeConversations;
  delivery: MessageOutboxDeliveryService;
  simulator: FeedbackSimulatorService;
  materializer: PostEventFeedbackMaterializer;
  queue: FakeQueue;
}

function createSimulatorHarness(): SimulatorHarness {
  const repository = new FakeSimulatorRepository();
  const conversations = new FakeConversations();
  const queue = new FakeQueue();
  const database = new FakeDatabase();
  const transport = new SimulatedFeedbackTransport(
    repository as unknown as FeedbackSimOutboundRepository,
  );

  conversations.seed({
    _id: conversationId,
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: phone,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: {
      mode: "bot",
      source: "launch",
      changedAt: observedAt,
    },
    messages: [],
    needsAttention: false,
  });

  const ingress = new PostEventFeedbackIngressService(
    queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
    database as unknown as DatabaseService,
    repository as unknown as FeedbackIngressRepository,
  );

  const outboundTranscript = new FeedbackOutboundTranscriptService(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
  );
  const outboundLog = new FeedbackOutboundLogService(
    repository as unknown as FeedbackOutboundLogRepository,
  );

  return {
    repository,
    conversations,
    queue,
    delivery: new MessageOutboxDeliveryService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      outboundTranscript,
      transport,
    ),
    simulator: new FeedbackSimulatorService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      {
        get(key: string) {
          return {
            NODE_ENV: "test",
            FEEDBACK_SIMULATOR_ENABLED: true,
            TRANSPORT_MODE: "simulated",
            FEEDBACK_EXTRACTION_MODEL: "google/gemini-3.6-flash",
          }[key];
        },
      } as never,
      ingress,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackResultsRepository,
      repository as unknown as FeedbackIngressRepository,
      repository as unknown as FeedbackOutboxRepository,
      repository as unknown as FeedbackSimOutboundRepository,
      conversations as unknown as FeedbackConversationRepository,
      {} as never,
      {} as never,
      {} as never,
      outboundTranscript,
    ),
    materializer: new PostEventFeedbackMaterializer(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackIngressRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      new FakeParticipants() as never,
      new FakeAudit() as never,
      new PostEventFeedbackMetrics(),
      outboundTranscript,
      outboundLog,
    ),
  };
}
