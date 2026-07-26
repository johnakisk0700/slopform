import { randomUUID } from "node:crypto";

import type { AppTransaction, AuditEventInsert } from "@join-the-six/database";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationTransitionError,
} from "../conversations/feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES,
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  feedbackConversationDocumentSchema,
  feedbackConversationMessageSchema,
  type FeedbackConversationDocument,
  type FeedbackConversationGoal,
  type FeedbackConversationMessage,
} from "../conversations/feedback-conversation.schemas.js";
import type { FeedbackOperatorAlertInput } from "./feedback-operator-alert.js";
import type {
  FeedbackTransport,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./feedback-transport.js";
import {
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
  strongerRecommendedAction,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "./post-event-feedback-attention.js";

/**
 * The faked seams of the post-event feedback loop: the two stores, the
 * participant/event/audit reads they hang off, the transport and the operator
 * alert. Everything else in the loop runs for real — see
 * `post-event-feedback-loop.harness.ts`, which is the file scenario authors
 * import.
 *
 * These doubles enforce the invariants the scenarios depend on rather than
 * merely recording calls. A fake that does not enforce a unique key turns a
 * revision scenario into a passing test that describes a system we do not have,
 * so the answer key, the outbox `dedupe_key`, the ingress key, the transcript's
 * contiguous `seq`, the replayed-with-different-content check, the transcript
 * capacity cap, the goal ladder, the close-reason precedence and the partial
 * unique index on an open conversation's phone are all real here.
 */

const GOAL_STATUS_RANK: Record<FeedbackConversationGoal["status"], number> = {
  pending: 0,
  asked: 1,
  skipped: 2,
  answered: 3,
};

/** Mirrors `createQueueProducerOptions`, which is where the real default lives. */
export const FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS = 5;

const TRANSACTION = { fake: "transaction" } as unknown as AppTransaction;

/**
 * Serialises work on a promise tail exactly as the existing module specs do, so
 * two concurrent runs interleave the way a real transaction would forbid.
 */
export class FakeDatabase {
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

export interface FakeCampaignRow {
  id: string;
  eventId: string;
  status: "launched" | "paused" | "closed";
  questions: Record<string, unknown>;
}

export interface FakeOutboxRow {
  id: string;
  conversationId: string;
  campaignId: string;
  kind: string;
  body: string;
  status: string;
  dedupeKey: string;
  createdByStaff: string | null;
  providerLogId: string | null;
  providerMessageId: string | null;
  deliveryStatus: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  playedAt: Date | null;
  deliveryUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeIngressRow {
  id: string;
  providerMessageId: string;
  chatJid: string;
  direction: "inbound" | "outbound";
  phoneE164: string | null;
  text: string | null;
  observedAt: Date;
  processingStatus: string;
  matchedConversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeAnswerRow {
  id: string;
  campaignId: string;
  conversationId: string;
  respondentParticipantId: string;
  subjectParticipantId: string | null;
  questionKey: string;
  valueInt: number | null;
  sourceMessageIds: string[];
  extractionMeta: Record<string, unknown>;
  createdAt: Date;
}

export interface FakeNoteRow {
  id: string;
  campaignId: string;
  conversationId: string;
  respondentParticipantId: string;
  subjectParticipantId: string | null;
  noteType: string;
  text: string;
  sourceMessageIds: string[];
  extractionMeta: Record<string, unknown>;
  status: string;
  createdAt: Date;
}

export interface FakeParticipantRow {
  id: string;
  preferredName: string | null;
  emailNormalized: string;
  phoneE164: string | null;
  postEventFeedbackWhatsappOptIn: boolean;
}

/** Stale `sending` rows older than this are reclaimed, as in the real relay. */
const OUTBOX_RECOVERY_MS = 5 * 60_000;

/**
 * The PostgreSQL side: campaigns, answers, notes, the outbox and the provider
 * ingress log, with their real unique keys and lease semantics.
 */
export class FakeFeedbackRepository {
  readonly campaigns = new Map<string, FakeCampaignRow>();
  readonly answers: FakeAnswerRow[] = [];
  readonly notes: FakeNoteRow[] = [];
  readonly outbox: FakeOutboxRow[] = [];
  readonly ingress: FakeIngressRow[] = [];

  constructor(private readonly now: () => Date) {}

  seedOutbox(
    input: Partial<FakeOutboxRow> & {
      conversationId: string;
      campaignId: string;
      body: string;
      dedupeKey: string;
    },
  ): FakeOutboxRow {
    const at = this.now();
    const row: FakeOutboxRow = {
      id: randomUUID(),
      kind: "reply",
      status: "pending",
      createdByStaff: null,
      providerLogId: null,
      providerMessageId: null,
      deliveryStatus: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      playedAt: null,
      deliveryUpdatedAt: null,
      createdAt: at,
      updatedAt: at,
      ...input,
    };
    this.outbox.push(row);
    return row;
  }

  async findCampaignById(id: string): Promise<FakeCampaignRow | undefined> {
    const row = this.campaigns.get(id);
    return row ? { ...row } : undefined;
  }

  async listAnswersByConversation(id: string): Promise<FakeAnswerRow[]> {
    return this.answers
      .filter((row) => row.conversationId === id)
      .map((row) => ({ ...row }));
  }

  async listNotesByConversation(id: string): Promise<FakeNoteRow[]> {
    return this.notes
      .filter((row) => row.conversationId === id)
      .map((row) => ({ ...row }));
  }

  async lockConversation(): Promise<void> {}

  /** Moving a person between mutually exclusive questions clears the old one. */
  async deleteContradictedAnswers(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      subjectParticipantId: string;
      questionKeys: readonly string[];
    },
  ): Promise<number> {
    if (input.questionKeys.length === 0) {
      return 0;
    }
    const before = this.answers.length;
    for (let index = this.answers.length - 1; index >= 0; index -= 1) {
      const row = this.answers[index];
      if (
        row &&
        row.conversationId === input.conversationId &&
        row.subjectParticipantId === input.subjectParticipantId &&
        input.questionKeys.includes(row.questionKey)
      ) {
        this.answers.splice(index, 1);
      }
    }
    return before - this.answers.length;
  }

  /**
   * `ON CONFLICT DO UPDATE` on (conversation, question_key, subject): the
   * newest reading of a question wins, because saying it again is how somebody
   * revises. The uniqueness key itself is unchanged and still real here.
   */
  async insertAnswerIfAbsent(
    _transaction: AppTransaction,
    input: {
      campaignId: string;
      conversationId: string;
      respondentParticipantId: string;
      subjectParticipantId?: string | null;
      questionKey: string;
      valueInt?: number | null;
      sourceMessageIds: readonly string[];
      extractionMeta: Record<string, unknown>;
    },
  ): Promise<FakeAnswerRow | undefined> {
    const subject = input.subjectParticipantId ?? null;
    const existing = this.answers.find(
      (row) =>
        row.conversationId === input.conversationId &&
        row.questionKey === input.questionKey &&
        row.subjectParticipantId === subject,
    );
    if (existing) {
      existing.valueInt = input.valueInt ?? null;
      existing.sourceMessageIds = [...input.sourceMessageIds];
      existing.extractionMeta = input.extractionMeta;
      return existing;
    }
    const row: FakeAnswerRow = {
      id: randomUUID(),
      campaignId: input.campaignId,
      conversationId: input.conversationId,
      respondentParticipantId: input.respondentParticipantId,
      subjectParticipantId: subject,
      questionKey: input.questionKey,
      valueInt: input.valueInt ?? null,
      sourceMessageIds: [...input.sourceMessageIds],
      extractionMeta: input.extractionMeta,
      createdAt: this.now(),
    };
    this.answers.push(row);
    return row;
  }

  async insertNote(
    _transaction: AppTransaction,
    input: {
      campaignId: string;
      conversationId: string;
      respondentParticipantId: string;
      subjectParticipantId?: string | null;
      noteType: string;
      text: string;
      sourceMessageIds: readonly string[];
      extractionMeta: Record<string, unknown>;
      status?: string;
    },
  ): Promise<FakeNoteRow> {
    const row: FakeNoteRow = {
      id: randomUUID(),
      campaignId: input.campaignId,
      conversationId: input.conversationId,
      respondentParticipantId: input.respondentParticipantId,
      subjectParticipantId: input.subjectParticipantId ?? null,
      noteType: input.noteType,
      text: input.text,
      sourceMessageIds: [...input.sourceMessageIds],
      extractionMeta: input.extractionMeta,
      status: input.status ?? "new",
      createdAt: this.now(),
    };
    this.notes.push(row);
    return row;
  }

  async insertOutboxIfAbsent(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      campaignId: string;
      kind: string;
      body: string;
      dedupeKey: string;
      status?: string;
      createdByStaff?: string | null;
    },
  ): Promise<{ row: FakeOutboxRow; inserted: boolean }> {
    const existing = this.outbox.find(
      (row) => row.dedupeKey === input.dedupeKey,
    );
    if (existing) {
      return { row: { ...existing }, inserted: false };
    }
    const row = this.seedOutbox({
      conversationId: input.conversationId,
      campaignId: input.campaignId,
      kind: input.kind,
      body: input.body,
      dedupeKey: input.dedupeKey,
      status: input.status ?? "pending",
      createdByStaff: input.createdByStaff ?? null,
    });
    return { row: { ...row }, inserted: true };
  }

  async findOutboxById(id: string): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    return row ? { ...row } : undefined;
  }

  async findOutboxByDedupeKey(
    dedupeKey: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find(
      (candidate) => candidate.dedupeKey === dedupeKey,
    );
    return row ? { ...row } : undefined;
  }

  async findOutboxByProviderMessageId(
    providerMessageId: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find(
      (candidate) => candidate.providerMessageId === providerMessageId,
    );
    return row ? { ...row } : undefined;
  }

  async findUnlinkedOutboxByConversationAndBody(
    conversationId: string,
    body: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.body === body &&
        candidate.providerMessageId === null &&
        ["pending", "sending", "sent"].includes(candidate.status),
    );
    return row ? { ...row } : undefined;
  }

  async listOutboxByConversation(
    conversationId: string,
  ): Promise<FakeOutboxRow[]> {
    return this.outbox
      .filter((row) => row.conversationId === conversationId)
      .map((row) => ({ ...row }));
  }

  async updateOutboxStatus(
    _transaction: AppTransaction,
    id: string,
    status: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (!row) {
      return undefined;
    }
    row.status = status;
    row.updatedAt = this.now();
    return { ...row };
  }

  async updateOutboxDelivery(
    _transaction: AppTransaction,
    id: string,
    input: {
      deliveryStatus: string;
      providerLogId?: string | null;
      providerMessageId?: string | null;
      sentAt?: Date | null;
      deliveredAt?: Date | null;
      readAt?: Date | null;
      playedAt?: Date | null;
      status?: string;
    },
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (!row) {
      return undefined;
    }
    row.deliveryStatus = input.deliveryStatus;
    row.deliveryUpdatedAt = this.now();
    row.updatedAt = this.now();
    if (input.providerLogId !== undefined) {
      row.providerLogId = input.providerLogId;
    }
    if (input.providerMessageId !== undefined) {
      row.providerMessageId = input.providerMessageId;
    }
    if (input.sentAt !== undefined) {
      row.sentAt = input.sentAt;
    }
    if (input.deliveredAt !== undefined) {
      row.deliveredAt = input.deliveredAt;
    }
    if (input.readAt !== undefined) {
      row.readAt = input.readAt;
    }
    if (input.playedAt !== undefined) {
      row.playedAt = input.playedAt;
    }
    if (input.status !== undefined) {
      row.status = input.status;
    }
    return { ...row };
  }

  async cancelQueuedOutboxForConversation(
    _transaction: AppTransaction,
    conversationId: string,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.conversationId === conversationId &&
        (row.status === "pending" || row.status === "held")
      ) {
        row.status = "cancelled";
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async cancelQueuedOutboxForCampaign(
    _transaction: AppTransaction,
    campaignId: string,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.campaignId === campaignId &&
        (row.status === "pending" || row.status === "held")
      ) {
        row.status = "cancelled";
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** `FOR UPDATE SKIP LOCKED` lease, gated on the campaign kill switch. */
  async claimOutboxBatch(now: Date, limit = 50): Promise<FakeOutboxRow[]> {
    const recoveryBefore = now.getTime() - OUTBOX_RECOVERY_MS;
    const claimable = this.outbox
      .filter(
        (row) =>
          row.status === "pending" ||
          (row.status === "sending" &&
            row.updatedAt.getTime() <= recoveryBefore),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .filter(
        (row) => this.campaigns.get(row.campaignId)?.status === "launched",
      );

    for (const row of claimable) {
      row.status = "sending";
      row.updatedAt = now;
    }
    return claimable.map((row) => ({ ...row }));
  }

  async releaseOutboxLease(
    id: string,
    now = this.now(),
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (
      !row ||
      row.status !== "sending" ||
      row.deliveryStatus !== null ||
      row.providerLogId !== null ||
      row.providerMessageId !== null
    ) {
      return undefined;
    }
    row.status = "pending";
    row.updatedAt = now;
    return { ...row };
  }

  /** Unique on `(chat_jid, provider_message_id)`. */
  async insertIngressIfAbsent(
    _transaction: AppTransaction,
    input: {
      providerMessageId: string;
      chatJid: string;
      direction: "inbound" | "outbound";
      phoneE164?: string | null;
      text?: string | null;
      observedAt: Date;
      processingStatus?: string;
      matchedConversationId?: string | null;
    },
  ): Promise<{ row: FakeIngressRow; inserted: boolean }> {
    const existing = this.ingress.find(
      (row) =>
        row.chatJid === input.chatJid &&
        row.providerMessageId === input.providerMessageId,
    );
    if (existing) {
      return { row: { ...existing }, inserted: false };
    }
    const at = this.now();
    const row: FakeIngressRow = {
      id: randomUUID(),
      providerMessageId: input.providerMessageId,
      chatJid: input.chatJid,
      direction: input.direction,
      phoneE164: input.phoneE164 ?? null,
      text: input.text ?? null,
      observedAt: input.observedAt,
      processingStatus: input.processingStatus ?? "pending",
      matchedConversationId: input.matchedConversationId ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.ingress.push(row);
    return { row: { ...row }, inserted: true };
  }

  async findIngressById(id: string): Promise<FakeIngressRow | undefined> {
    const row = this.ingress.find((candidate) => candidate.id === id);
    return row ? { ...row } : undefined;
  }

  async findIngressByIdForUpdate(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FakeIngressRow | undefined> {
    return this.findIngressById(id);
  }

  async findIngressByChatAndProviderMessage(
    _executor: AppTransaction,
    chatJid: string,
    providerMessageId: string,
  ): Promise<FakeIngressRow | undefined> {
    const row = this.ingress.find(
      (candidate) =>
        candidate.chatJid === chatJid &&
        candidate.providerMessageId === providerMessageId,
    );
    return row ? { ...row } : undefined;
  }

  async updateIngressProcessing(
    _transaction: AppTransaction,
    id: string,
    input: {
      processingStatus: string;
      matchedConversationId?: string | null;
      text?: string | null;
      phoneE164?: string | null;
    },
  ): Promise<FakeIngressRow | undefined> {
    const row = this.ingress.find((candidate) => candidate.id === id);
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
    if (input.phoneE164 !== undefined) {
      row.phoneE164 = input.phoneE164;
    }
    row.updatedAt = this.now();

    // `provider_message_ingress_unmatched_text_check`, as amended: an unmatched
    // row is still attributed to no conversation, but it may keep its body.
    if (
      row.processingStatus === "ignored_unmatched" &&
      row.matchedConversationId !== null
    ) {
      throw new Error(
        "provider_message_ingress_unmatched_text_check: an ignored_unmatched row keeps no conversation link",
      );
    }
    return { ...row };
  }

  async listPendingIngressOlderThan(
    olderThan: Date,
    limit = 50,
  ): Promise<FakeIngressRow[]> {
    return this.ingress
      .filter(
        (row) =>
          row.processingStatus === "pending" &&
          row.createdAt.getTime() <= olderThan.getTime(),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
}

export interface FakeConversationTransition {
  changed: boolean;
  conversation: FeedbackConversationDocument;
}

export interface FakeConversationCreation {
  created: boolean;
  conversation: FeedbackConversationDocument;
}

export interface FakeConversationAppend {
  appended: boolean;
  message: FeedbackConversationMessage;
  conversation: FeedbackConversationDocument;
}

/**
 * The MongoDB side: one schema-v2 aggregate per conversation, validated against
 * the real document schema after every mutation so contiguous `seq`, unique
 * provenance and the cursor bound cannot silently drift.
 */
export class FakeFeedbackConversations {
  readonly documents = new Map<string, FeedbackConversationDocument>();

  seed(document: FeedbackConversationDocument): FeedbackConversationDocument {
    const parsed = feedbackConversationDocumentSchema.parse(document);
    this.assertPhoneAvailable(parsed);
    this.documents.set(parsed._id, parsed);
    return parsed;
  }

  /** Test-side reader. Production code never sees this. */
  get(id: string): FeedbackConversationDocument {
    const conversation = this.documents.get(id);
    if (!conversation) {
      throw new Error(`Conversation ${id} was not seeded`);
    }
    return conversation;
  }

  async createFromLaunch(input: {
    campaignId: string;
    respondentParticipantId: string;
    phoneAtLaunch: string;
    launchedAt: Date;
    goals?: readonly FeedbackConversationGoal[];
  }): Promise<FakeConversationCreation> {
    const existing = [...this.documents.values()].find(
      (candidate) =>
        candidate.campaignId === input.campaignId &&
        candidate.respondentParticipantId === input.respondentParticipantId,
    );
    if (existing) {
      return { created: false, conversation: structuredClone(existing) };
    }
    const conversation = this.seed({
      _id: randomUUID(),
      schemaVersion: 2,
      purpose: "post_event_feedback",
      channel: "whatsapp",
      campaignId: input.campaignId,
      respondentParticipantId: input.respondentParticipantId,
      phoneAtLaunch: input.phoneAtLaunch,
      lifecycle: { state: "open", reason: null, closedAt: null },
      control: { mode: "bot", source: "launch", changedAt: input.launchedAt },
      goals: [...(input.goals ?? [])],
      messages: [],
      extraction: { cursorSeq: 0, lastRunAt: null, model: null },
      needsAttention: false,
      remindedAt: null,
      reminderCount: 0,
      awaitingHuman: false,
      createdAt: input.launchedAt,
      updatedAt: input.launchedAt,
    });
    return { created: true, conversation: structuredClone(conversation) };
  }

  async findById(
    id: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    const conversation = this.documents.get(id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  /** D9: the partial unique index only ever matches an **open** conversation. */
  async findOpenByPhone(
    phoneAtLaunch: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    const conversation = [...this.documents.values()].find(
      (candidate) =>
        candidate.phoneAtLaunch === phoneAtLaunch &&
        candidate.lifecycle.state === "open",
    );
    return conversation ? structuredClone(conversation) : undefined;
  }

  async findLatestClosedByPhone(
    phoneAtLaunch: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    // Newest first, mirroring the real `sort: { updatedAt: -1 }`.
    const conversation = [...this.documents.values()]
      .reverse()
      .find(
        (candidate) =>
          candidate.phoneAtLaunch === phoneAtLaunch &&
          candidate.lifecycle.state === "closed",
      );
    return conversation ? structuredClone(conversation) : undefined;
  }

  async listForCampaign(
    campaignId: string,
  ): Promise<FeedbackConversationDocument[]> {
    return [...this.documents.values()]
      .filter((candidate) => candidate.campaignId === campaignId)
      .map((candidate) => structuredClone(candidate));
  }

  async appendMessage(input: {
    conversationId: string;
    actor: FeedbackConversationMessage["actor"];
    text: string;
    at: Date;
    id?: string;
    providerMessageId?: string | null;
    ingressId?: string | null;
    outboxId?: string | null;
  }): Promise<FakeConversationAppend> {
    const conversation = this.require(input.conversationId);
    const keys = [input.id, input.ingressId, input.outboxId].filter(
      (value): value is string => Boolean(value),
    );
    if (keys.length === 0) {
      throw new ConversationPersistenceError(
        "A feedback conversation message requires an ingress id, an outbox id or a stable id",
      );
    }

    const existing = conversation.messages.find((message) =>
      [message.id, message.ingressId, message.outboxId]
        .filter((value): value is string => Boolean(value))
        .some((key) => keys.includes(key)),
    );
    if (existing) {
      if (
        existing.actor !== input.actor ||
        existing.text !== input.text.trim()
      ) {
        throw new ConversationPersistenceError(
          "A feedback conversation message was replayed with different content",
        );
      }
      return {
        appended: false,
        message: existing,
        conversation: structuredClone(conversation),
      };
    }

    const message = feedbackConversationMessageSchema.parse({
      id: input.id ?? randomUUID(),
      seq: conversation.messages.length + 1,
      actor: input.actor,
      text: input.text,
      providerMessageId: input.providerMessageId ?? null,
      ingressId: input.ingressId ?? null,
      outboxId: input.outboxId ?? null,
      attention: null,
      at: input.at,
    });

    if (this.exceedsCapacity(conversation, message)) {
      await this.setNeedsAttention({
        conversationId: conversation._id,
        needsAttention: true,
        at: input.at,
      });
      throw new FeedbackConversationCapacityError();
    }

    // Mirrors the real `$push` with `$sort`: stored in the order the
    // participant spoke, not the order the webhooks arrived. `seq` is assigned
    // on arrival and is deliberately not renumbered — the extraction cursor is
    // a `seq` and must not be reshuffled underneath a run.
    conversation.messages.push(message);
    conversation.messages.sort(
      (left, right) =>
        left.at.getTime() - right.at.getTime() || left.seq - right.seq,
    );
    this.touch(conversation, message.at);
    this.revalidate(conversation);
    return {
      appended: true,
      message,
      conversation: structuredClone(conversation),
    };
  }

  async mergeMessageAttention(input: {
    conversationId: string;
    messageId: string;
    categories: readonly PostEventFeedbackSafetyCategory[];
    recommendedAction: PostEventFeedbackRecommendedAction;
    confidence: number;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    const message = conversation.messages.find(
      (candidate) => candidate.id === input.messageId,
    );
    if (!message) {
      throw new FeedbackConversationTransitionError(
        `Feedback message ${input.messageId} was not found`,
      );
    }
    if (message.actor !== "participant") {
      throw new FeedbackConversationTransitionError(
        "Only participant messages can carry attention metadata",
      );
    }

    message.attention = {
      categories: POST_EVENT_FEEDBACK_SAFETY_CATEGORIES.filter(
        (category) =>
          message.attention?.categories.includes(category) ||
          input.categories.includes(category),
      ),
      recommendedAction: message.attention
        ? strongerRecommendedAction(
            message.attention.recommendedAction,
            input.recommendedAction,
          )
        : input.recommendedAction,
      confidence: Math.max(
        message.attention?.confidence ?? 0,
        input.confidence,
      ),
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async takeOver(input: {
    conversationId: string;
    source: "staff_action" | "external_outbound";
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.control.mode !== "bot") {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.control = {
      mode: "human",
      source: input.source,
      changedAt: input.at,
    };
    conversation.awaitingHuman = false;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  /** The bot steps back without giving up control; only a person clears it. */
  async markAwaitingHuman(input: {
    conversationId: string;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.lifecycle.state !== "open") {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.awaitingHuman = true;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async resumeBot(input: {
    conversationId: string;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.lifecycle.state === "closed") {
      throw new FeedbackConversationTransitionError(
        "A closed feedback conversation cannot resume bot control",
      );
    }
    if (conversation.control.mode !== "human") {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.control = {
      mode: "bot",
      source: "staff_action",
      changedAt: input.at,
    };
    conversation.awaitingHuman = false;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  /** The first closure wins, except that a STOP overrides a softer reason. */
  async close(input: {
    conversationId: string;
    reason: "completed" | "stopped" | "expired" | "cancelled";
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    const allowed =
      input.reason === "stopped"
        ? conversation.lifecycle.reason !== "stopped"
        : conversation.lifecycle.state === "open";
    if (!allowed) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.lifecycle = {
      state: "closed",
      reason: input.reason,
      closedAt: input.at,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async advanceCursor(input: {
    conversationId: string;
    toSeq: number;
    at: Date;
    model?: string | null;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (input.toSeq > conversation.messages.length) {
      throw new FeedbackConversationTransitionError(
        "The extraction cursor cannot pass the transcript",
      );
    }
    if (input.toSeq <= conversation.extraction.cursorSeq) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.extraction = {
      cursorSeq: input.toSeq,
      lastRunAt: input.at,
      model: input.model ?? null,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  /** Monotonic along `pending < asked < skipped < answered`. */
  async updateGoalStatuses(input: {
    conversationId: string;
    statuses: readonly {
      key: FeedbackConversationGoal["key"];
      status: FeedbackConversationGoal["status"];
    }[];
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    let changed = false;
    for (const entry of input.statuses) {
      const goal = conversation.goals.find((item) => item.key === entry.key);
      if (
        goal &&
        GOAL_STATUS_RANK[entry.status] > GOAL_STATUS_RANK[goal.status]
      ) {
        goal.status = entry.status;
        changed = true;
      }
    }
    if (changed) {
      this.touch(conversation, input.at);
      this.revalidate(conversation);
    }
    return { changed, conversation: structuredClone(conversation) };
  }

  async setNeedsAttention(input: {
    conversationId: string;
    needsAttention: boolean;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    const changed = conversation.needsAttention !== input.needsAttention;
    conversation.needsAttention = input.needsAttention;
    if (changed) {
      this.touch(conversation, input.at);
      this.revalidate(conversation);
    }
    return { changed, conversation: structuredClone(conversation) };
  }

  async markReminded(input: {
    conversationId: string;
    at: Date;
    expectedCount: number;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.reminderCount !== input.expectedCount
    ) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.remindedAt = input.at;
    conversation.reminderCount = input.expectedCount + 1;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async listOpenDueForReminder(input: {
    olderThan: Date;
    maxReminders: number;
    limit?: number;
  }): Promise<FeedbackConversationDocument[]> {
    return this.listOpenOlderThan(input.olderThan, input.limit).filter(
      (conversation) => conversation.reminderCount < input.maxReminders,
    );
  }

  async listOpenDueForExpiry(input: {
    olderThan: Date;
    limit?: number;
  }): Promise<FeedbackConversationDocument[]> {
    return this.listOpenOlderThan(input.olderThan, input.limit);
  }

  private listOpenOlderThan(
    olderThan: Date,
    limit = 50,
  ): FeedbackConversationDocument[] {
    return [...this.documents.values()]
      .filter(
        (conversation) =>
          conversation.lifecycle.state === "open" &&
          conversation.control.mode === "bot" &&
          conversation.createdAt.getTime() <= olderThan.getTime(),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left._id.localeCompare(right._id),
      )
      .slice(0, limit)
      .map((conversation) => structuredClone(conversation));
  }

  private require(id: string): FeedbackConversationDocument {
    const conversation = this.documents.get(id);
    if (!conversation) {
      throw new FeedbackConversationNotFoundError(id);
    }
    return conversation;
  }

  private touch(conversation: FeedbackConversationDocument, at: Date): void {
    if (at > conversation.updatedAt) {
      conversation.updatedAt = at;
    }
  }

  private revalidate(conversation: FeedbackConversationDocument): void {
    feedbackConversationDocumentSchema.parse(conversation);
  }

  private assertPhoneAvailable(
    conversation: FeedbackConversationDocument,
  ): void {
    if (conversation.lifecycle.state !== "open") {
      return;
    }
    const clash = [...this.documents.values()].some(
      (candidate) =>
        candidate._id !== conversation._id &&
        candidate.lifecycle.state === "open" &&
        candidate.phoneAtLaunch === conversation.phoneAtLaunch,
    );
    if (clash) {
      throw new FeedbackConversationPhoneConflictError();
    }
  }

  private exceedsCapacity(
    conversation: FeedbackConversationDocument,
    message: FeedbackConversationMessage,
  ): boolean {
    if (conversation.messages.length >= FEEDBACK_CONVERSATION_MAX_MESSAGES) {
      return true;
    }
    // The real repository measures BSON; a UTF-8 byte count of the same content
    // is the same order of magnitude and needs no BSON dependency here.
    return (
      Buffer.byteLength(JSON.stringify(conversation)) +
        Buffer.byteLength(JSON.stringify(message)) >
      FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES
    );
  }
}

export class FakeParticipants {
  readonly rows = new Map<string, FakeParticipantRow>();

  async findById(id: string): Promise<FakeParticipantRow | undefined> {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  async findByIds(ids: readonly string[]): Promise<FakeParticipantRow[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [{ ...row }] : [];
    });
  }

  async findByIdForUpdate(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FakeParticipantRow | undefined> {
    return this.findById(id);
  }

  async updateFeedbackOptIn(
    _transaction: AppTransaction,
    id: string,
    postEventFeedbackWhatsappOptIn: boolean,
  ): Promise<FakeParticipantRow | undefined> {
    const row = this.rows.get(id);
    if (!row) {
      return undefined;
    }
    row.postEventFeedbackWhatsappOptIn = postEventFeedbackWhatsappOptIn;
    return { ...row };
  }
}

/**
 * D16's seam, and only D16's seam. Attendance is mutable so a scenario can
 * correct it mid-conversation and prove that live selection picks it up.
 */
export class FakeEvents {
  candidates: { participantId: string; displayName: string }[] = [];

  async listFeedbackCandidatesForRespondent(
    _eventId: string,
    respondentParticipantId: string,
  ): Promise<{ items: { participantId: string; displayName: string }[] }> {
    return {
      items: this.candidates
        .filter(
          (candidate) => candidate.participantId !== respondentParticipantId,
        )
        .map((candidate) => ({ ...candidate })),
    };
  }
}

export class FakeAudit {
  readonly events: AuditEventInsert[] = [];

  async append(
    _transaction: AppTransaction,
    event: AuditEventInsert,
  ): Promise<void> {
    this.events.push(event);
  }
}

/** Mirrors BullMQ's job-id suppression while the job is still in Redis. */
export class FakeQueue {
  readonly added: {
    name: string;
    data: unknown;
    jobId: string;
    delay?: number;
  }[] = [];

  async add(
    name: string,
    data: unknown,
    options: { jobId: string; delay?: number },
  ): Promise<{ id: string }> {
    if (!this.added.some((job) => job.jobId === options.jobId)) {
      this.added.push({
        name,
        data,
        jobId: options.jobId,
        ...(options.delay === undefined ? {} : { delay: options.delay }),
      });
    }
    return { id: options.jobId };
  }
}

export class FakeOperatorAlert {
  readonly raised: FeedbackOperatorAlertInput[] = [];

  async raise(input: FeedbackOperatorAlertInput): Promise<void> {
    this.raised.push(input);
  }
}

export type RecordedSend = {
  readonly outboxId: string;
  readonly to: string;
  readonly text: string;
  readonly at: Date;
};

/**
 * The assertion surface for "what the participant actually received". It is the
 * transport rather than the outbox on purpose: a row that is cancelled at send
 * time satisfies an outbox-based assertion while the participant heard nothing.
 */
export class RecordingFeedbackTransport implements FeedbackTransport {
  readonly sent: RecordedSend[] = [];
  /** Flip to make the provider refuse or go quiet. */
  outcome: "accepted" | "not-accepted" | "unknown" = "accepted";
  private counter = 0;

  constructor(private readonly now: () => Date) {}

  async sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
    this.counter += 1;
    if (this.outcome === "not-accepted") {
      return { outcome: "not-accepted", reason: "provider_rejected" };
    }
    if (this.outcome === "unknown") {
      return {
        outcome: "unknown",
        reason: "timeout",
        providerLogId: `log-${this.counter}`,
      };
    }
    this.sent.push({
      outboxId: input.outboxId,
      to: input.to,
      text: input.text,
      at: this.now(),
    });
    return {
      outcome: "accepted",
      providerLogId: `log-${this.counter}`,
      providerStatus: "sent",
      providerMessageId: `wa-out-${this.counter}`,
    };
  }
}
