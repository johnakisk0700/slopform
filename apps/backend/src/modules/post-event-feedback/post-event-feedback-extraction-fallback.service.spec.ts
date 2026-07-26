import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import type { EventsService } from "../events/events.service.js";
import type { FeedbackOperatorAlertInput } from "./feedback-operator-alert.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import {
  FakeAudit,
  FakeEvents,
} from "./post-event-feedback-doubles.harness.js";
import { PostEventFeedbackExtractionFallback } from "./extraction/fallback.service.js";
import {
  POST_EVENT_FEEDBACK_FALLBACK_ACK,
  POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT,
} from "./extraction/extraction.schemas.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./post-event-feedback-question-set.js";
import type { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "./extraction/results.repository.js";
import type { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const eventId = "6b1d2f43-2f6a-4a1f-9f39-0f2c1f6c9a10";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const respondentId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const kostasOne = "1b2c3d4e-0000-4000-8000-000000000001";
const kostasTwo = "1b2c3d4e-0000-4000-8000-000000000002";
const eleni = "1b2c3d4e-0000-4000-8000-000000000003";
const correlationId = "correlation-1";

const disclosure = "Ο Κώστας μας έδειχνε dickpics όλο το βράδυ";

describe("PostEventFeedbackExtractionFallback", () => {
  let harness: Harness;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    harness = createHarness();
  });

  it("records one note, one acknowledgement and one audit event", async () => {
    const result = await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "provider_refusal",
    });

    expect(result.applied).toBe(true);
    expect(harness.repository.notes).toHaveLength(1);
    expect(harness.repository.outbox).toHaveLength(1);
    expect(harness.audit.events).toHaveLength(1);

    expect(harness.repository.notes[0]).toMatchObject({
      noteType: "general",
      status: "new",
      text: POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT,
      conversationId,
      campaignId,
      respondentParticipantId: respondentId,
      // Provenance points at the exact message the run died on.
      sourceMessageIds: ["p1"],
    });
    expect(harness.audit.events[0]).toMatchObject({
      action: "feedback_conversation.extraction_failed",
      entityType: "feedback_conversation",
      entityId: conversationId,
      context: { cause: "provider_refusal", sourceMessageId: "p1" },
    });
  });

  it("fabricates no model or confidence in the note's provenance", async () => {
    await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "provider_refusal",
    });

    const meta = harness.repository.notes[0]?.extractionMeta as
      Record<string, unknown> | undefined;
    expect(meta).toMatchObject({
      origin: "deterministic_fallback",
      cause: "provider_refusal",
      candidateIds: [kostasOne, kostasTwo, eleni],
    });
    // No model ran to completion, so an absent field is the honest record; a
    // zero confidence would read as a real low-confidence extraction.
    expect(meta).not.toHaveProperty("model");
    expect(meta).not.toHaveProperty("confidence");
  });

  it("acknowledges and restates the current goal so the thread does not stall", async () => {
    await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "provider_refusal",
    });

    const reply = harness.repository.outbox[0];
    expect(reply).toMatchObject({
      kind: "reply",
      dedupeKey: `feedback-fallback-${conversationId}-1`,
    });
    expect(reply?.body).toBe(
      `${POST_EVENT_FEEDBACK_FALLBACK_ACK} ${POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.liked}`,
    );
    // And it reaches the transcript as a bot turn, like every other outbound.
    expect(
      harness.conversations.transcript(conversationId).at(-1),
    ).toMatchObject({ actor: "bot", text: reply?.body, outboxId: reply?.id });
  });

  it("raises attention and alerts the operator exactly once", async () => {
    await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "provider_refusal",
    });

    expect(harness.conversations.get(conversationId).needsAttention).toBe(true);
    expect(harness.alert.raised).toHaveLength(1);
    expect(harness.alert.raised[0]).toMatchObject({
      conversationId,
      campaignId,
      reason: "extraction_failed",
      detail: ["provider_refusal"],
    });
  });

  it("writes nothing a second time when the failure replays", async () => {
    await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "provider_refusal",
    });
    const replay = await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "provider_refusal",
    });

    // The outbox dedupe key fences the whole effect, not just the send.
    expect(replay.applied).toBe(false);
    expect(harness.repository.notes).toHaveLength(1);
    expect(harness.repository.outbox).toHaveLength(1);
    expect(harness.audit.events).toHaveLength(1);
    expect(harness.alert.raised).toHaveLength(1);
    expect(harness.conversations.transcript(conversationId)).toHaveLength(2);
  });

  describe("subject resolution (D16 candidates, D18 degradation)", () => {
    it("directs the note when exactly one candidate name appears", async () => {
      harness.events.candidates = [
        { participantId: kostasOne, displayName: "Κώστας Παπαδόπουλος" },
        { participantId: eleni, displayName: "Ελένη Νικολάου" },
      ];

      const result = await harness.fallback.apply({
        conversationId,
        correlationId,
        cause: "provider_refusal",
      });

      expect(result.subjectParticipantId).toBe(kostasOne);
      expect(harness.repository.notes[0]?.subjectParticipantId).toBe(kostasOne);
      expect(harness.repository.notes[0]?.extractionMeta).not.toHaveProperty(
        "flaggedForReview",
      );
    });

    it("stays subjectless when two candidates share the name", async () => {
      // Both ids are valid, so a correct pick and a lucky guess are the same
      // move. The extraction prompt asks a clarifying question; a deterministic
      // fallback has no such option and must not assert anything.
      const result = await harness.fallback.apply({
        conversationId,
        correlationId,
        cause: "provider_refusal",
      });

      expect(result.subjectParticipantId).toBeNull();
      expect(harness.repository.notes[0]?.subjectParticipantId).toBeNull();
      expect(harness.repository.notes[0]?.extractionMeta).toMatchObject({
        flaggedForReview: true,
      });
    });

    it("stays subjectless when no candidate is named", async () => {
      harness.conversations.setLastParticipantText("Ήταν απαίσια η βραδιά");

      const result = await harness.fallback.apply({
        conversationId,
        correlationId,
        cause: "provider_error",
      });

      expect(result.subjectParticipantId).toBeNull();
    });

    it("ignores a name that is no longer a current candidate", async () => {
      harness.events.candidates = [
        { participantId: eleni, displayName: "Ελένη Νικολάου" },
      ];

      const result = await harness.fallback.apply({
        conversationId,
        correlationId,
        cause: "provider_refusal",
      });

      expect(result.subjectParticipantId).toBeNull();
    });

    it("matches a folded given name against a full display name", async () => {
      harness.events.candidates = [
        { participantId: kostasOne, displayName: "Κώστας Παπαδόπουλος" },
      ];
      harness.conversations.setLastParticipantText("ο κωστας ηταν απαισιος");

      const result = await harness.fallback.apply({
        conversationId,
        correlationId,
        cause: "provider_refusal",
      });

      expect(result.subjectParticipantId).toBe(kostasOne);
    });
  });

  it("records every bounded cause class it is given", async () => {
    for (const cause of [
      "provider_refusal",
      "provider_error",
      "validation_failed",
      "unknown",
    ] as const) {
      harness = createHarness();
      await harness.fallback.apply({ conversationId, correlationId, cause });

      expect(harness.audit.events[0]).toMatchObject({ context: { cause } });
      expect(harness.repository.notes[0]?.extractionMeta).toMatchObject({
        cause,
      });
    }
  });

  it("flags attention but writes nothing when there is no participant turn", async () => {
    harness.conversations.get(conversationId).messages = [
      {
        id: "b1",
        seq: 1,
        actor: "bot",
        text: "Γεια σου!",
        ingressId: null,
        outboxId: "outbox-1",
      },
    ];

    const result = await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "unknown",
    });

    // A note with no source message would have no provenance, and an
    // acknowledgement would answer a message nobody sent.
    expect(result.applied).toBe(false);
    expect(harness.repository.notes).toHaveLength(0);
    expect(harness.repository.outbox).toHaveLength(0);
    expect(harness.conversations.get(conversationId).needsAttention).toBe(true);
  });

  it("does nothing at all when the conversation is gone", async () => {
    harness.conversations.documents.clear();

    const result = await harness.fallback.apply({
      conversationId,
      correlationId,
      cause: "unknown",
    });

    expect(result.applied).toBe(false);
    expect(harness.alert.raised).toHaveLength(0);
  });
});

interface FakeMessage {
  id: string;
  seq: number;
  actor: string;
  text: string;
  ingressId: string | null;
  outboxId: string | null;
}

interface FakeConversation {
  _id: string;
  campaignId: string;
  respondentParticipantId: string;
  goals: { key: string; ordinal: number; prompt: string; status: string }[];
  messages: FakeMessage[];
  needsAttention: boolean;
}

interface FakeNoteRow {
  id: string;
  campaignId: string;
  conversationId: string;
  respondentParticipantId: string;
  subjectParticipantId: string | null;
  noteType: string;
  text: string;
  sourceMessageIds: readonly string[];
  extractionMeta: Record<string, unknown>;
  status: string;
}

interface FakeOutboxRow {
  id: string;
  conversationId: string;
  campaignId: string;
  kind: string;
  body: string;
  dedupeKey: string;
  status: string;
}

// Deliberately does not serialise on a promise tail; the shared FakeDatabase
// would. Leave this local so concurrent runs can interleave.
class FakeDatabase {
  async transaction<T>(work: (transaction: AppTransaction) => Promise<T>) {
    return work({} as AppTransaction);
  }
}

class FakeFeedbackRepository {
  readonly notes: FakeNoteRow[] = [];
  readonly outbox: FakeOutboxRow[] = [];
  readonly campaigns = new Map<string, { id: string; eventId: string }>();

  async lockConversation(): Promise<void> {}

  async findCampaignById(id: string) {
    return this.campaigns.get(id);
  }

  async insertNote(
    _transaction: AppTransaction,
    input: Omit<FakeNoteRow, "id" | "subjectParticipantId" | "status"> & {
      subjectParticipantId?: string | null;
      status?: string;
    },
  ): Promise<FakeNoteRow> {
    const row: FakeNoteRow = {
      ...input,
      id: randomUUID(),
      subjectParticipantId: input.subjectParticipantId ?? null,
      status: input.status ?? "new",
    };
    this.notes.push(row);
    return row;
  }

  async insertOutboxIfAbsent(
    _transaction: AppTransaction,
    input: Omit<FakeOutboxRow, "id" | "status">,
  ): Promise<{ row: FakeOutboxRow; inserted: boolean }> {
    const existing = this.outbox.find(
      (row) => row.dedupeKey === input.dedupeKey,
    );
    if (existing) {
      return { row: { ...existing }, inserted: false };
    }
    const row: FakeOutboxRow = {
      ...input,
      id: randomUUID(),
      status: "pending",
    };
    this.outbox.push(row);
    return { row: { ...row }, inserted: true };
  }

  async updateOutboxStatus(
    _transaction: AppTransaction,
    id: string,
    status: string,
  ): Promise<void> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (row) {
      row.status = status;
    }
  }
}

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

  setLastParticipantText(text: string): void {
    const conversation = this.get(conversationId);
    const message = [...conversation.messages]
      .reverse()
      .find((candidate) => candidate.actor === "participant");
    if (message) {
      message.text = text;
    }
  }

  transcript(id: string) {
    return this.get(id).messages.map((message) => ({
      seq: message.seq,
      actor: message.actor,
      text: message.text,
      outboxId: message.outboxId,
    }));
  }

  async findById(id: string): Promise<FakeConversation | undefined> {
    return this.documents.get(id);
  }

  async appendMessage(input: {
    conversationId: string;
    actor: string;
    text: string;
    at: Date;
    outboxId?: string | null;
  }): Promise<{ appended: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const existing = conversation.messages.find(
      (message) => message.outboxId && message.outboxId === input.outboxId,
    );
    if (existing) {
      return { appended: false, conversation };
    }
    conversation.messages.push({
      id: randomUUID(),
      seq: conversation.messages.length + 1,
      actor: input.actor,
      text: input.text,
      ingressId: null,
      outboxId: input.outboxId ?? null,
    });
    return { appended: true, conversation };
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
  fallback: PostEventFeedbackExtractionFallback;
  repository: FakeFeedbackRepository;
  conversations: FakeConversations;
  events: FakeEvents;
  audit: FakeAudit;
  alert: { raised: FeedbackOperatorAlertInput[] };
}

function createHarness(): Harness {
  const repository = new FakeFeedbackRepository();
  const conversations = new FakeConversations();
  const events = new FakeEvents();
  const audit = new FakeAudit();
  const alert = {
    raised: [] as FeedbackOperatorAlertInput[],
    async raise(input: FeedbackOperatorAlertInput): Promise<void> {
      this.raised.push(input);
    },
  };

  repository.campaigns.set(campaignId, { id: campaignId, eventId });
  // Two Κώστας by default: the ambiguous case is the interesting one, so the
  // tests that want a resolvable subject narrow the set explicitly.
  events.candidates = [
    { participantId: kostasOne, displayName: "Κώστας Παπαδόπουλος" },
    { participantId: kostasTwo, displayName: "Κώστας Δήμου" },
    { participantId: eleni, displayName: "Ελένη Νικολάου" },
  ];

  conversations.seed({
    _id: conversationId,
    campaignId,
    respondentParticipantId: respondentId,
    goals: [
      {
        key: "event_score",
        ordinal: 1,
        prompt: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.event_score,
        status: "answered",
      },
      {
        key: "liked",
        ordinal: 2,
        prompt: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.liked,
        status: "asked",
      },
      {
        key: "avoid",
        ordinal: 3,
        prompt: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.avoid,
        status: "pending",
      },
    ],
    messages: [
      {
        id: "p1",
        seq: 1,
        actor: "participant",
        text: disclosure,
        ingressId: "ingress-1",
        outboxId: null,
      },
    ],
    needsAttention: false,
  });

  const database = new FakeDatabase();
  const fallback = new PostEventFeedbackExtractionFallback(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackCampaignRepository,
    repository as unknown as FeedbackResultsRepository,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsService,
    audit as unknown as AuditRepository,
    new FeedbackOutboundTranscriptService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
    ),
    alert,
  );

  return { fallback, repository, conversations, events, audit, alert };
}
