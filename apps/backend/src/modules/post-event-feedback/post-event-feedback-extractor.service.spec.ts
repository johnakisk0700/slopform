import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction, AuditEventInsert } from "@join-the-six/database";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import type { EventsService } from "../events/events.service.js";
import type { ParticipantsRepository } from "../participants/participants.repository.js";
import { PostEventFeedbackExtractor } from "./post-event-feedback-extractor.service.js";
import type { PostEventFeedbackExtractionModel } from "./post-event-feedback-extraction.service.js";
import { PostEventFeedbackMetrics } from "./post-event-feedback-metrics.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./post-event-feedback-question-set.js";
import { POST_EVENT_FEEDBACK_HANDOFF_REPLY } from "./post-event-feedback-extraction.schemas.js";
import type { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const eventId = "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10";
const respondentId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const nikos = "1b0a2f1c-2d3e-4f50-8a91-0b2c3d4e5f60";
const eleni = "2c1b3a2d-3e4f-5061-9b02-1c3d4e5f6071";
const correlationId = "correlation-1";
const model = "google/gemini-3.6-flash";

describe("PostEventFeedbackExtractor", () => {
  let harness: Harness;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    harness = createHarness();
  });

  describe("cheap exits", () => {
    it("skips a closed conversation without calling the model", async () => {
      harness.conversations.get(conversationId).lifecycle = {
        state: "closed",
        reason: "stopped",
        closedAt: new Date(),
      };

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_closed");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("skips a conversation under human control", async () => {
      harness.conversations.get(conversationId).control = {
        mode: "human",
        source: "staff_action",
        changedAt: new Date(),
      };

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_human_control");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("skips when the cursor already covers the transcript", async () => {
      harness.conversations.get(conversationId).extraction.cursorSeq = 2;

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_cursor");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("advances the cursor without a model call when only the bot spoke", async () => {
      const conversation = harness.conversations.get(conversationId);
      conversation.messages = [
        { id: "b1", seq: 1, actor: "bot", text: "Καλησπέρα!", at: new Date() },
      ];
      conversation.extraction.cursorSeq = 0;

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_no_new_testimony");
      expect(harness.generation.propose).not.toHaveBeenCalled();
      expect(conversation.extraction.cursorSeq).toBe(1);
    });
  });

  describe("the extraction run", () => {
    it("persists answers and notes with the run's model, confidence and candidate ids", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 5,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.95,
            },
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: ["p1"],
              confidence: 0.8,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Η βραδιά κύλησε γρήγορα.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
          nextGoal: "meet_again",
          reply: "Ευχαριστούμε! Με ποιους θα ήθελες να ξαναβρεθείς;",
        }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result).toMatchObject({
        outcome: "extracted",
        answersWritten: 2,
        notesWritten: 1,
        cursorSeq: 2,
        model,
      });
      // D12: the candidate set of *this* run is what makes live selection
      // auditable later.
      expect(harness.repository.answers[0]?.extractionMeta).toEqual({
        model,
        confidence: 0.95,
        candidateIds: [nikos, eleni],
      });
      expect(harness.repository.notes[0]?.extractionMeta).toEqual({
        model,
        confidence: 0.6,
        candidateIds: [nikos, eleni],
      });
    });

    it("selects candidates live for every run rather than from the document", async () => {
      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.events.listFeedbackCandidatesForRespondent,
      ).toHaveBeenCalledWith(eventId, respondentId);
    });

    it("records a degraded subject in the note meta instead of guessing", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          notes: [
            {
              noteType: "general",
              text: "Η Ρούλα ήταν πολύ γλυκιά.",
              subjectParticipantId: null,
              subjectMentionedName: "Ρούλα",
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.repository.notes[0]).toMatchObject({
        subjectParticipantId: null,
        extractionMeta: {
          model,
          confidence: 0.6,
          candidateIds: [nikos, eleni],
          flaggedForReview: true,
          unresolvedSubjectName: "Ρούλα",
        },
      });
    });

    it("enqueues exactly one reply keyed by conversation and cursor", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ reply: "Ευχαριστούμε πολύ!" }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          conversationId,
          campaignId,
          kind: "reply",
          body: "Ευχαριστούμε πολύ!",
          dedupeKey: `feedback-reply-${conversationId}-2`,
        }),
      ]);
    });

    it("marks the answered goal and the asked next goal", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
          reply: "Ποιος σου έκανε εντύπωση;",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.conversations.goalStatuses(conversationId)).toMatchObject({
        event_score: "answered",
        liked: "asked",
      });
    });

    it("never sends when opt-in was withdrawn, but still keeps the answers", async () => {
      harness.participants.rows.set(respondentId, {
        id: respondentId,
        postEventFeedbackWhatsappOptIn: false,
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          reply: "Ευχαριστούμε!",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.repository.answers).toHaveLength(1);
      expect(harness.repository.outbox).toHaveLength(0);
    });
  });

  describe("completion", () => {
    it("closes as completed and sends the campaign's closing copy once", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"], reply: "Ευχαριστούμε!" }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("completed");
      expect(harness.conversations.get(conversationId).lifecycle).toMatchObject(
        {
          state: "closed",
          reason: "completed",
        },
      );
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.closing,
          dedupeKey: `feedback-closing-${conversationId}`,
        }),
      ]);
    });

    it("prefers the campaign's launch copy snapshot over the constant", async () => {
      harness.repository.campaigns.set(campaignId, {
        id: campaignId,
        eventId,
        questions: { copy: { closing: "Τα λέμε στο επόμενο τραπέζι!" } },
      });
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"] }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.repository.outbox[0]?.body).toBe(
        "Τα λέμε στο επόμενο τραπέζι!",
      );
    });
  });

  describe("safety and handoff (D13)", () => {
    it("flags attention, audits and sends the neutral handoff instead of the model reply", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          notes: [
            {
              noteType: "general",
              text: "Ο συμμετέχων δεν αντέχει.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          safetySignal: true,
          reply: "Λυπάμαι που το ακούω, θες να μιλήσουμε;",
        }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("handoff");
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        true,
      );
      expect(harness.repository.notes).toHaveLength(0);
      expect(harness.repository.outbox[0]).toMatchObject({
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
        dedupeKey: `feedback-handoff-${conversationId}-2`,
      });
      expect(harness.audit.events[0]).toMatchObject({
        action: "feedback_conversation.safety_signalled",
        entityType: "feedback_conversation",
        entityId: conversationId,
      });
    });

    it("does not seize control; a takeover stays an explicit human action (D17)", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.conversations.get(conversationId).control.mode).toBe(
        "bot",
      );
      expect(harness.audit.events[0]).toMatchObject({
        action: "feedback_conversation.handoff_requested",
      });
    });
  });

  describe("replay", () => {
    it("writes nothing new when the same job runs twice", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Ωραία βραδιά.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
          reply: "Ευχαριστούμε!",
        }),
      );

      const first = await harness.extractor.extract({
        conversationId,
        correlationId,
      });
      const replay = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(first.outcome).toBe("extracted");
      // The cursor now covers the transcript, so the replay stops before the
      // model is called a second time.
      expect(replay.outcome).toBe("skipped_cursor");
      expect(harness.generation.propose).toHaveBeenCalledTimes(1);
      expect(harness.repository.answers).toHaveLength(1);
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.repository.outbox).toHaveLength(1);
    });

    it("absorbs a crash between the PostgreSQL commit and the cursor advance", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Ωραία βραδιά.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
          reply: "Ευχαριστούμε!",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });
      // The worker died before MongoDB learned the run had finished.
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;

      const replay = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(replay.outcome).toBe("extracted");
      expect(replay.answersWritten).toBe(0);
      expect(replay.notesWritten).toBe(0);
      expect(harness.repository.answers).toHaveLength(1);
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.repository.outbox).toHaveLength(1);
      expect(
        harness.conversations.get(conversationId).extraction.cursorSeq,
      ).toBe(2);
    });

    it("repairs goal statuses from stored answers after such a replay", async () => {
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 4,
        noteType: null,
        text: null,
        extractionMeta: { model, confidence: 1, candidateIds: [] },
      });
      harness.generation.propose.mockResolvedValue(generation({}));

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.goalStatuses(conversationId).event_score,
      ).toBe("answered");
    });
  });

  describe("observability", () => {
    it("logs token usage per run rather than message count", async () => {
      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.metrics.totalTokensObserved()).toBe(910);
      expect(harness.metrics.countExtract("extracted")).toBe(1);
    });
  });

  it("does not retry a job whose conversation is gone", async () => {
    await expect(
      harness.extractor.extract({
        conversationId: randomUUID(),
        correlationId,
      }),
    ).rejects.toThrow(/was not found/u);
  });

  it("does not retry a job whose campaign is gone", async () => {
    harness.repository.campaigns.clear();

    await expect(
      harness.extractor.extract({ conversationId, correlationId }),
    ).rejects.toThrow(/campaign .* was not found/iu);
  });
});

interface FakeMessage {
  id: string;
  seq: number;
  actor: "bot" | "participant" | "staff" | "system";
  text: string;
  at: Date;
}

interface FakeGoal {
  key: "event_score" | "liked" | "meet_again" | "avoid";
  ordinal: number;
  prompt: string;
  status: "pending" | "asked" | "answered" | "skipped";
}

interface FakeConversation {
  _id: string;
  campaignId: string;
  respondentParticipantId: string;
  lifecycle: { state: string; reason: string | null; closedAt: Date | null };
  control: { mode: string; source: string; changedAt: Date };
  goals: FakeGoal[];
  messages: FakeMessage[];
  extraction: {
    cursorSeq: number;
    lastRunAt: Date | null;
    model: string | null;
  };
  needsAttention: boolean;
}

interface FakeResultRow {
  id: string;
  conversationId: string;
  questionKey: string | null;
  noteType: string | null;
  text: string | null;
  valueInt: number | null;
  subjectParticipantId: string | null;
  extractionMeta: Record<string, unknown>;
}

const TRANSACTION = { fake: "transaction" } as unknown as AppTransaction;

class FakeDatabase {
  private tail: Promise<unknown> = Promise.resolve();

  async transaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => work(TRANSACTION));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Mirrors the WP2 repository contract the extractor actually depends on. */
class FakeFeedbackRepository {
  readonly campaigns = new Map<
    string,
    { id: string; eventId: string; questions: Record<string, unknown> }
  >();
  readonly answers: FakeResultRow[] = [];
  readonly notes: FakeResultRow[] = [];
  readonly outbox: Record<string, unknown>[] = [];
  locked = 0;

  async findCampaignById(id: string) {
    return this.campaigns.get(id);
  }

  async listAnswersByConversation(id: string) {
    return this.answers.filter((row) => row.conversationId === id);
  }

  async listNotesByConversation(id: string) {
    return this.notes.filter((row) => row.conversationId === id);
  }

  lockConversation(): Promise<unknown> {
    this.locked += 1;
    return Promise.resolve();
  }

  /** `ON CONFLICT DO NOTHING` on (conversation, question_key, subject). */
  async insertAnswerIfAbsent(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      questionKey: string;
      subjectParticipantId?: string | null;
      valueInt?: number | null;
      extractionMeta: Record<string, unknown>;
    },
  ): Promise<FakeResultRow | undefined> {
    const subject = input.subjectParticipantId ?? null;
    const exists = this.answers.some(
      (row) =>
        row.conversationId === input.conversationId &&
        row.questionKey === input.questionKey &&
        row.subjectParticipantId === subject,
    );
    if (exists) {
      return undefined;
    }
    const row: FakeResultRow = {
      id: randomUUID(),
      conversationId: input.conversationId,
      questionKey: input.questionKey,
      noteType: null,
      text: null,
      valueInt: input.valueInt ?? null,
      subjectParticipantId: subject,
      extractionMeta: input.extractionMeta,
    };
    this.answers.push(row);
    return row;
  }

  async insertNote(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      noteType: string;
      text: string;
      subjectParticipantId?: string | null;
      extractionMeta: Record<string, unknown>;
    },
  ): Promise<FakeResultRow> {
    const row: FakeResultRow = {
      id: randomUUID(),
      conversationId: input.conversationId,
      questionKey: null,
      noteType: input.noteType,
      text: input.text,
      valueInt: null,
      subjectParticipantId: input.subjectParticipantId ?? null,
      extractionMeta: input.extractionMeta,
    };
    this.notes.push(row);
    return row;
  }

  async insertOutboxIfAbsent(
    _transaction: AppTransaction,
    input: { dedupeKey: string } & Record<string, unknown>,
  ): Promise<{ row: Record<string, unknown>; inserted: boolean }> {
    const existing = this.outbox.find(
      (row) => row["dedupeKey"] === input.dedupeKey,
    );
    if (existing) {
      return { row: existing, inserted: false };
    }
    const row = { id: randomUUID(), status: "pending", ...input };
    this.outbox.push(row);
    return { row, inserted: true };
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

  goalStatuses(id: string): Record<string, string> {
    return Object.fromEntries(
      this.get(id).goals.map((goal) => [goal.key, goal.status]),
    );
  }

  setAllGoals(id: string, status: FakeGoal["status"]): void {
    for (const goal of this.get(id).goals) {
      goal.status = status;
    }
  }

  setGoal(id: string, key: string, status: FakeGoal["status"]): void {
    const goal = this.get(id).goals.find((entry) => entry.key === key);
    if (goal) {
      goal.status = status;
    }
  }

  async findById(id: string): Promise<FakeConversation | undefined> {
    const conversation = this.documents.get(id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  /** Monotonic along pending < asked < skipped < answered. */
  async updateGoalStatuses(input: {
    conversationId: string;
    statuses: readonly { key: string; status: FakeGoal["status"] }[];
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const rank = { pending: 0, asked: 1, skipped: 2, answered: 3 } as const;
    const conversation = this.get(input.conversationId);
    let changed = false;
    for (const entry of input.statuses) {
      const goal = conversation.goals.find((item) => item.key === entry.key);
      if (goal && rank[entry.status] > rank[goal.status]) {
        goal.status = entry.status;
        changed = true;
      }
    }
    return { changed, conversation };
  }

  async advanceCursor(input: {
    conversationId: string;
    toSeq: number;
    at: Date;
    model?: string | null;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    if (input.toSeq <= conversation.extraction.cursorSeq) {
      return { changed: false, conversation };
    }
    conversation.extraction = {
      cursorSeq: input.toSeq,
      lastRunAt: input.at,
      model: input.model ?? null,
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

  async close(input: {
    conversationId: string;
    reason: string;
    at: Date;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    if (conversation.lifecycle.state === "closed") {
      return { changed: false, conversation };
    }
    conversation.lifecycle = {
      state: "closed",
      reason: input.reason,
      closedAt: input.at,
    };
    return { changed: true, conversation };
  }
}

class FakeParticipants {
  readonly rows = new Map<
    string,
    { id: string; postEventFeedbackWhatsappOptIn: boolean }
  >();

  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
}

class FakeAudit {
  readonly events: AuditEventInsert[] = [];

  async append(
    _transaction: AppTransaction,
    event: AuditEventInsert,
  ): Promise<void> {
    this.events.push(event);
  }
}

interface Harness {
  extractor: PostEventFeedbackExtractor;
  repository: FakeFeedbackRepository;
  conversations: FakeConversations;
  participants: FakeParticipants;
  events: { listFeedbackCandidatesForRespondent: ReturnType<typeof vi.fn> };
  generation: { propose: ReturnType<typeof vi.fn> };
  audit: FakeAudit;
  metrics: PostEventFeedbackMetrics;
}

function generation(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model,
    usage: { inputTokens: 800, outputTokens: 110, totalTokens: 910 },
    proposal: {
      answers: [],
      notes: [],
      skippedGoals: [],
      nextGoal: null,
      reply: null,
      handoff: false,
      safetySignal: false,
      confidence: 0.9,
      ...overrides,
    },
  };
}

function createHarness(): Harness {
  const repository = new FakeFeedbackRepository();
  const conversations = new FakeConversations();
  const participants = new FakeParticipants();
  const audit = new FakeAudit();
  const metrics = new PostEventFeedbackMetrics();
  const events = {
    listFeedbackCandidatesForRespondent: vi.fn().mockResolvedValue({
      items: [
        { participantId: nikos, displayName: "Νίκος" },
        { participantId: eleni, displayName: "Ελένη" },
      ],
    }),
  };
  const generationService = {
    propose: vi.fn().mockResolvedValue(generation({})),
  };

  repository.campaigns.set(campaignId, {
    id: campaignId,
    eventId,
    questions: {},
  });
  participants.rows.set(respondentId, {
    id: respondentId,
    postEventFeedbackWhatsappOptIn: true,
  });
  conversations.seed({
    _id: conversationId,
    campaignId,
    respondentParticipantId: respondentId,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: {
      mode: "bot",
      source: "launch",
      changedAt: new Date("2026-07-25T10:00:00.000Z"),
    },
    goals: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.map(
      (question, index) => ({
        key: question.key,
        ordinal: index + 1,
        prompt: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy[question.key],
        status: "asked" as const,
      }),
    ),
    messages: [
      {
        id: "b1",
        seq: 1,
        actor: "bot",
        text: "Πώς σου φάνηκε η βραδιά;",
        at: new Date("2026-07-25T10:01:00.000Z"),
      },
      {
        id: "p1",
        seq: 2,
        actor: "participant",
        text: "5! Ο Νίκος ήταν φοβερός. Η βραδιά κύλησε γρήγορα.",
        at: new Date("2026-07-25T10:02:00.000Z"),
      },
    ],
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
  });

  const extractor = new PostEventFeedbackExtractor(
    new FakeDatabase() as unknown as DatabaseService,
    repository as unknown as PostEventFeedbackRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsService,
    participants as unknown as ParticipantsRepository,
    generationService as unknown as PostEventFeedbackExtractionModel,
    audit as unknown as AuditRepository,
    metrics,
  );

  return {
    extractor,
    repository,
    conversations,
    participants,
    events,
    generation: generationService,
    audit,
    metrics,
  };
}
