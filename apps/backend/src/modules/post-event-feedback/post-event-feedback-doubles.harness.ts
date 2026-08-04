import { randomUUID } from "node:crypto";

import type { AppTransaction, AuditEventInsert } from "@join-the-six/database";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import type { EventFeedbackVenueSnapshot } from "../events/event-venue.js";
import type { EventVenueInput } from "../events/events.schemas.js";
import {
  FEEDBACK_ANSWER_CORRECTIONS_KEY,
  isCorrectedAnswer,
} from "./extraction/answer-corrections.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationTransitionError,
} from "./post-event-feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES,
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  accumulateFeedbackExtractionUsage,
  feedbackConversationDocumentSchema,
  feedbackConversationStoredMessageSchema,
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
  type FeedbackConversationExtractionUsage,
  type FeedbackConversationGoal,
  type FeedbackConversationMessage,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationWork,
} from "./post-event-feedback-conversation.document.js";
import type { FeedbackOperatorAlertInput } from "./operator-alert.js";
import type { FeedbackOutboundDecision } from "./outbox/outbound-log.schemas.js";
import type { OutboundConversationSnapshot } from "./outbox/outbound-log.snapshot.js";
import type {
  FeedbackTransport,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./outbox/transport.js";
import {
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
  strongerRecommendedAction,
  type PostEventFeedbackAttentionReason,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "./attention.js";

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
  questionSetVersion: number;
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
  claimToken: string | null;
  claimExpiresAt: Date | null;
  sendStartedAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeOutboxLogRow {
  id: string;
  outboxId: string;
  conversationId: string;
  campaignId: string;
  origin: string;
  correlationId: string;
  decision: FeedbackOutboundDecision;
  conversationState: OutboundConversationSnapshot;
  createdAt: Date;
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
  matchingHold: boolean;
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
  readonly outboxLogs: FakeOutboxLogRow[] = [];
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
      claimToken: null,
      claimExpiresAt: null,
      sendStartedAt: null,
      attemptCount: 0,
      lastError: null,
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

  async findCampaignByIdForShare(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FakeCampaignRow | undefined> {
    return this.findCampaignById(id);
  }

  async findCampaignByIdForUpdate(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FakeCampaignRow | undefined> {
    return this.findCampaignById(id);
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

  async listOutboxStatusesByIds(
    outboxIds: readonly string[],
  ): Promise<{ outboxId: string; status: string }[]> {
    const selected = new Set(outboxIds);
    return this.outbox
      .filter((row) => selected.has(row.id))
      .map((row) => ({ outboxId: row.id, status: row.status }));
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
        input.questionKeys.includes(row.questionKey) &&
        // A row an operator corrected is not the model's to delete.
        !isCorrectedAnswer(row.extractionMeta)
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
      matchingHold?: boolean;
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
      // `setWhere: not (extraction_meta ? 'corrections')` — a corrected row is
      // frozen, and the conflicting insert writes nothing at all.
      if (isCorrectedAnswer(existing.extractionMeta)) {
        return undefined;
      }
      existing.valueInt = input.valueInt ?? null;
      existing.sourceMessageIds = [...input.sourceMessageIds];
      // `matching_hold = feedback_answers.matching_hold or excluded.matching_hold`
      // — a later burst restating the answer politely does not lift the hold.
      existing.matchingHold =
        existing.matchingHold || input.matchingHold === true;
      // The update merges provenance over the old blob and carries
      // `corrections` across rather than replacing it wholesale.
      const carried = existing.extractionMeta[FEEDBACK_ANSWER_CORRECTIONS_KEY];
      existing.extractionMeta = {
        ...input.extractionMeta,
        ...(carried === undefined
          ? {}
          : { [FEEDBACK_ANSWER_CORRECTIONS_KEY]: carried }),
      };
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
      matchingHold: input.matchingHold === true,
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
      id?: string;
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
      ...(input.id ? { id: input.id } : {}),
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

  async resolveLegacyClosingBeforeAnchoredInsert(
    _transaction: AppTransaction,
    legacyDedupeKey: string,
  ): Promise<
    { outcome: "clear" } | { outcome: "provider_crossed"; row: FakeOutboxRow }
  > {
    const legacy = this.outbox.find((row) => row.dedupeKey === legacyDedupeKey);
    if (
      !legacy ||
      legacy.status === "failed" ||
      legacy.status === "cancelled"
    ) {
      return { outcome: "clear" };
    }
    if (
      ["attempting", "ambiguous", "sending", "sent"].includes(legacy.status) ||
      legacy.sendStartedAt !== null
    ) {
      return { outcome: "provider_crossed", row: { ...legacy } };
    }
    if (["pending", "held", "claimed"].includes(legacy.status)) {
      legacy.status = "cancelled";
      legacy.claimExpiresAt = null;
      legacy.lastError = "superseded_by_anchored_closing";
      legacy.updatedAt = this.now();
    }
    return { outcome: "clear" };
  }

  async insertOutboxLogIfAbsent(
    _transaction: AppTransaction,
    input: {
      outboxId: string;
      conversationId: string;
      campaignId: string;
      origin: string;
      correlationId: string;
      decision: FeedbackOutboundDecision;
      conversationState: OutboundConversationSnapshot;
    },
  ): Promise<{ row: FakeOutboxLogRow; inserted: boolean }> {
    const existing = this.outboxLogs.find(
      (row) => row.outboxId === input.outboxId,
    );
    if (existing) {
      return { row: { ...existing }, inserted: false };
    }
    const row: FakeOutboxLogRow = {
      id: randomUUID(),
      outboxId: input.outboxId,
      conversationId: input.conversationId,
      campaignId: input.campaignId,
      origin: input.origin,
      correlationId: input.correlationId,
      decision: input.decision,
      conversationState: input.conversationState,
      createdAt: this.now(),
    };
    this.outboxLogs.push(row);
    return { row: { ...row }, inserted: true };
  }

  async findLogByOutboxId(
    outboxId: string,
  ): Promise<FakeOutboxLogRow | undefined> {
    const row = this.outboxLogs.find(
      (candidate) => candidate.outboxId === outboxId,
    );
    return row ? structuredClone(row) : undefined;
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
        (row.status === "pending" ||
          row.status === "held" ||
          row.status === "claimed")
      ) {
        row.status = "cancelled";
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async cancelQueuedAutomatedOutboxForConversation(
    _transaction: AppTransaction,
    conversationId: string,
    authorizedOutboxId?: string | null,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.conversationId === conversationId &&
        row.id !== authorizedOutboxId &&
        row.kind !== "staff" &&
        (row.status === "pending" ||
          row.status === "held" ||
          row.status === "claimed")
      ) {
        row.status = "cancelled";
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async cancelQueuedSupersededAutomationForConversation(
    _transaction: AppTransaction,
    conversationId: string,
    preservedOutboxIds: readonly string[] = [],
  ): Promise<number> {
    const preserved = new Set(preservedOutboxIds);
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.conversationId === conversationId &&
        !preserved.has(row.id) &&
        row.kind !== "system" &&
        row.kind !== "staff" &&
        row.sendStartedAt === null &&
        (row.status === "pending" ||
          row.status === "held" ||
          row.status === "claimed")
      ) {
        row.status = "cancelled";
        row.claimExpiresAt = null;
        row.lastError = "superseded_by_newer_testimony";
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async cancelQueuedOutboxById(
    _transaction: AppTransaction,
    id: string,
    _lastError?: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (
      !row ||
      (row.status !== "pending" &&
        row.status !== "held" &&
        row.status !== "claimed")
    ) {
      return undefined;
    }
    row.status = "cancelled";
    row.updatedAt = this.now();
    return { ...row };
  }

  async cancelQueuedOutboxForConversationExceptId(
    _transaction: AppTransaction,
    conversationId: string,
    authorizedOutboxId: string | null,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.conversationId === conversationId &&
        row.id !== authorizedOutboxId &&
        row.sendStartedAt === null &&
        (row.status === "pending" ||
          row.status === "held" ||
          row.status === "claimed")
      ) {
        row.status = "cancelled";
        row.claimExpiresAt = null;
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async cancelQueuedOutboxForCampaign(
    _transaction: AppTransaction,
    campaignId: string,
    preservedOutboxIds: readonly string[] = [],
  ): Promise<number> {
    const preserved = new Set(preservedOutboxIds);
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row.campaignId === campaignId &&
        !preserved.has(row.id) &&
        (row.status === "pending" ||
          row.status === "held" ||
          row.status === "claimed")
      ) {
        row.status = "cancelled";
        row.updatedAt = this.now();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** Direct-dispatch claim semantics used by the executable loop harness. */
  async listTerminalDispatchCandidates(
    limit = 50,
  ): Promise<{ conversationId: string; outboxId: string }[]> {
    const liveBlocking = new Set([
      "pending",
      "held",
      "claimed",
      "attempting",
      "sending",
    ]);
    return this.outbox
      .filter(
        (row) =>
          row.kind === "system" &&
          row.dedupeKey === `feedback-stop-ack-${row.conversationId}` &&
          (row.status === "pending" ||
            (row.status === "claimed" &&
              row.sendStartedAt === null &&
              (row.claimExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <=
                this.now().getTime())),
      )
      .filter((row) => {
        const older = this.outbox.filter(
          (candidate) =>
            candidate.conversationId === row.conversationId &&
            (candidate.createdAt.getTime() < row.createdAt.getTime() ||
              (candidate.createdAt.getTime() === row.createdAt.getTime() &&
                candidate.id < row.id)),
        );
        return (
          (this.campaigns.get(row.campaignId)?.status !== "launched" ||
            older.some((candidate) => candidate.status === "ambiguous")) &&
          !older.some((candidate) => liveBlocking.has(candidate.status))
        );
      })
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((row) => ({
        conversationId: row.conversationId,
        outboxId: row.id,
      }));
  }

  async claimDispatchBatch(
    now: Date,
    limit = 4,
    leaseMs = 2 * 60_000,
    terminalOutboxIds: readonly string[] = [],
  ): Promise<FakeOutboxRow[]> {
    const blocking = new Set([
      "pending",
      "held",
      "claimed",
      "attempting",
      "ambiguous",
      "sending",
    ]);
    const authorizedTerminalIds = new Set(terminalOutboxIds);
    const candidates = this.outbox
      .filter(
        (row) =>
          (this.campaigns.get(row.campaignId)?.status === "launched" ||
            authorizedTerminalIds.has(row.id)) &&
          (row.status === "pending" ||
            (row.status === "claimed" &&
              row.sendStartedAt === null &&
              (row.claimExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <=
                now.getTime())),
      )
      .filter(
        (row) =>
          !this.outbox.some(
            (older) =>
              older.conversationId === row.conversationId &&
              blocking.has(older.status) &&
              !(
                older.status === "ambiguous" &&
                (row.kind === "staff" || authorizedTerminalIds.has(row.id))
              ) &&
              (older.createdAt.getTime() < row.createdAt.getTime() ||
                (older.createdAt.getTime() === row.createdAt.getTime() &&
                  older.id < row.id)),
          ),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
    const claimToken = randomUUID();
    for (const row of candidates) {
      row.status = "claimed";
      row.claimToken = claimToken;
      row.claimExpiresAt = new Date(now.getTime() + leaseMs);
      row.sendStartedAt = null;
      row.lastError = null;
      row.updatedAt = now;
    }
    return candidates.map((row) => ({ ...row }));
  }

  async renewDispatchClaim(
    id: string,
    claimToken: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findLiveClaim(id, claimToken);
    if (!row) return undefined;
    row.claimExpiresAt = new Date(now.getTime() + leaseMs);
    row.updatedAt = now;
    return { ...row };
  }

  async releaseDispatchClaim(
    id: string,
    claimToken: string,
    now: Date,
    lastError?: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findLiveClaim(id, claimToken);
    if (!row) return undefined;
    row.status = "pending";
    row.claimToken = null;
    row.claimExpiresAt = null;
    row.lastError = lastError ?? null;
    row.updatedAt = now;
    return { ...row };
  }

  async finishDispatchClaimBeforeAttempt(
    id: string,
    claimToken: string,
    status: "failed" | "cancelled",
    now: Date,
    lastError: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findLiveClaim(id, claimToken);
    if (!row) return undefined;
    row.status = status;
    row.claimExpiresAt = null;
    row.lastError = lastError;
    if (status === "failed") {
      row.deliveryStatus = "error";
      row.deliveryUpdatedAt = now;
    }
    row.updatedAt = now;
    return { ...row };
  }

  async markDispatchAttemptStarted(
    id: string,
    claimToken: string,
    now: Date,
    leaseMs = 2 * 60_000,
    authorizedStopOutboxId: string | null = null,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findLiveClaim(id, claimToken);
    if (
      !row ||
      (row.claimExpiresAt?.getTime() ?? 0) <= now.getTime() ||
      (this.campaigns.get(row.campaignId)?.status !== "launched" &&
        authorizedStopOutboxId !== row.id)
    ) {
      return undefined;
    }
    row.status = "attempting";
    row.sendStartedAt = now;
    row.claimExpiresAt = new Date(now.getTime() + leaseMs);
    row.attemptCount += 1;
    row.lastError = null;
    row.updatedAt = now;
    return { ...row };
  }

  async markDispatchSent(
    id: string,
    claimToken: string,
    input: {
      completedAt: Date;
      providerLogId: string;
      providerMessageId?: string;
      deliveryStatus: string;
      sentAt?: Date | null;
    },
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findActiveAttempt(id, claimToken);
    if (!row) return undefined;
    row.status = "sent";
    row.claimExpiresAt = null;
    row.providerLogId = input.providerLogId;
    row.providerMessageId = input.providerMessageId ?? null;
    row.deliveryStatus = input.deliveryStatus;
    row.deliveryUpdatedAt = input.completedAt;
    row.sentAt = input.sentAt ?? null;
    row.lastError = null;
    row.updatedAt = input.completedAt;
    return { ...row };
  }

  async markDispatchFailed(
    id: string,
    claimToken: string,
    now: Date,
    lastError: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findActiveAttempt(id, claimToken);
    if (!row) return undefined;
    row.status = "failed";
    row.claimExpiresAt = null;
    row.deliveryStatus = "error";
    row.deliveryUpdatedAt = now;
    row.lastError = lastError;
    row.updatedAt = now;
    return { ...row };
  }

  async markDispatchAmbiguous(
    id: string,
    claimToken: string,
    now: Date,
    lastError: string,
    providerLogId?: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findActiveAttempt(id, claimToken);
    if (!row) return undefined;
    row.status = "ambiguous";
    row.claimExpiresAt = null;
    row.deliveryStatus = "pending";
    row.deliveryUpdatedAt = now;
    row.providerLogId = providerLogId ?? row.providerLogId;
    row.lastError = lastError;
    row.updatedAt = now;
    return { ...row };
  }

  async findExpiredDispatchAttempts(now: Date): Promise<FakeOutboxRow[]> {
    return this.outbox
      .filter(
        (row) =>
          row.status === "attempting" &&
          (row.claimExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <=
            now.getTime(),
      )
      .map((row) => ({ ...row }));
  }

  async quarantineExpiredDispatchAttempt(
    id: string,
    claimToken: string,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.findActiveAttempt(id, claimToken, false);
    if (
      !row ||
      (row.claimExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) >
        this.now().getTime()
    ) {
      return undefined;
    }
    return this.quarantine(row, "dispatch_lease_expired_after_send_start");
  }

  async findStaleLegacySending(
    now: Date,
    recoveryMs = OUTBOX_RECOVERY_MS,
  ): Promise<FakeOutboxRow[]> {
    const staleBefore = now.getTime() - recoveryMs;
    return this.outbox
      .filter(
        (row) =>
          row.status === "sending" && row.updatedAt.getTime() <= staleBefore,
      )
      .map((row) => ({ ...row }));
  }

  async quarantineStaleLegacySending(
    id: string,
    recoveryMs = OUTBOX_RECOVERY_MS,
  ): Promise<FakeOutboxRow | undefined> {
    const row = this.outbox.find((candidate) => candidate.id === id);
    if (
      !row ||
      row.status !== "sending" ||
      row.updatedAt.getTime() > this.now().getTime() - recoveryMs
    ) {
      return undefined;
    }
    row.claimToken = null;
    row.sendStartedAt = null;
    row.attemptCount = 0;
    return this.quarantine(row, "legacy_sending_cutover_ambiguous");
  }

  private findLiveClaim(
    id: string,
    claimToken: string,
  ): FakeOutboxRow | undefined {
    return this.outbox.find(
      (row) =>
        row.id === id &&
        row.status === "claimed" &&
        row.claimToken === claimToken &&
        row.sendStartedAt === null,
    );
  }

  private findActiveAttempt(
    id: string,
    claimToken: string,
    requireLiveLease = true,
  ): FakeOutboxRow | undefined {
    return this.outbox.find(
      (row) =>
        row.id === id &&
        row.status === "attempting" &&
        row.claimToken === claimToken &&
        row.sendStartedAt !== null &&
        (!requireLiveLease ||
          (row.claimExpiresAt?.getTime() ?? 0) > this.now().getTime()),
    );
  }

  private quarantine(row: FakeOutboxRow, lastError: string): FakeOutboxRow {
    const now = this.now();
    row.status = "ambiguous";
    row.claimExpiresAt = null;
    row.deliveryStatus ??= "pending";
    row.deliveryUpdatedAt ??= now;
    row.lastError = lastError;
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

  async lockInboundPhone(): Promise<void> {}

  async hasInboundBeyondSnapshot(
    _transaction: AppTransaction,
    input: {
      phoneE164: string;
      conversationId: string;
      snapshotIngressIds: readonly string[];
    },
  ): Promise<boolean> {
    const snapshotIngressIds = new Set(input.snapshotIngressIds);
    return this.ingress.some(
      (row) =>
        row.direction === "inbound" &&
        row.phoneE164 === input.phoneE164 &&
        !snapshotIngressIds.has(row.id) &&
        (row.processingStatus === "pending" ||
          (row.processingStatus === "materialized" &&
            row.matchedConversationId === input.conversationId)),
    );
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

  async listPendingIngressOlderThan(input: {
    readonly olderThan: Date;
    readonly limit?: number;
    readonly after?: { readonly createdAt: Date; readonly ingressId: string };
  }): Promise<FakeIngressRow[]> {
    const limit = input.limit ?? 50;
    return this.ingress
      .filter(
        (row) =>
          row.processingStatus === "pending" &&
          row.createdAt.getTime() <= input.olderThan.getTime() &&
          (!input.after ||
            row.createdAt.getTime() > input.after.createdAt.getTime() ||
            (row.createdAt.getTime() === input.after.createdAt.getTime() &&
              row.id > input.after.ingressId)),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listPendingIngressForSerializationKey(
    key: { phoneE164: string | null; chatJid: string },
    limit = 50,
  ): Promise<FakeIngressRow[]> {
    return this.ingress
      .filter(
        (row) =>
          row.processingStatus === "pending" &&
          (key.phoneE164
            ? row.phoneE164 === key.phoneE164
            : row.phoneE164 === null && row.chatJid === key.chatJid),
      )
      .sort(
        (left, right) =>
          left.observedAt.getTime() - right.observedAt.getTime() ||
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
      extraction: {
        cursorSeq: 0,
        lastRunAt: null,
        model: null,
        usage: null,
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
      needsAttention: false,
      attentionReasons: [],
      remindedAt: null,
      reminderCount: 0,
      awaitingHuman: false,
      hostileTurns: 0,
      extractionFallbackAckSent: false,
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

  async markWorkDue(input: {
    conversationId: string;
    nextActionAt: Date;
    at: Date;
  }): Promise<{
    changed: boolean;
    conversation: FeedbackConversationDocument;
    work: FeedbackConversationWork;
  }> {
    const conversation = this.require(input.conversationId);
    const current = resolveFeedbackConversationWork(conversation.work);
    conversation.work = {
      ...current,
      revision: current.revision + 1,
      nextActionAt: input.nextActionAt,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return {
      changed: true,
      conversation: structuredClone(conversation),
      work: structuredClone(conversation.work),
    };
  }

  async seedMissingWork(input: {
    dueAt: Date;
    limit?: number;
  }): Promise<number> {
    const candidates = [...this.documents.values()]
      .filter(
        (conversation) =>
          conversation.lifecycle.state === "open" &&
          conversation.control.mode === "bot" &&
          !conversation.awaitingHuman &&
          conversation.work === undefined,
      )
      .sort((left, right) => left._id.localeCompare(right._id))
      .slice(0, input.limit ?? 100);
    for (const conversation of candidates) {
      conversation.work = {
        revision: 1,
        nextActionAt: input.dueAt,
        executionEpoch: 0,
      };
      this.revalidate(conversation);
    }
    return candidates.length;
  }

  async repairLegacyAwaitingHuman(input: {
    at: Date;
    limit?: number;
  }): Promise<number> {
    const repairableKinds = new Set([
      "handoff",
      "unfinished_questionnaire",
      "hostile_to_bot",
      "undelivered_message",
    ]);
    const candidates = [...this.documents.values()]
      .filter(
        (conversation) =>
          conversation.lifecycle.state === "open" &&
          conversation.control.mode === "bot" &&
          conversation.control.source !== "staff_action" &&
          !conversation.awaitingHuman &&
          !conversation.messages.some(
            (message) =>
              message.actor === "participant" &&
              message.seq > conversation.extraction.cursorSeq,
          ) &&
          (conversation.attentionReasons.some(
            (reason) =>
              reason.resolvedAt === null && repairableKinds.has(reason.kind),
          ) ||
            conversation.messages.some(
              (message) =>
                message.attention?.recommendedAction ===
                "urgent_human_follow_up",
            )),
      )
      .sort((left, right) => left._id.localeCompare(right._id))
      .slice(0, input.limit ?? 100);
    for (const conversation of candidates) {
      conversation.awaitingHuman = true;
      this.touch(conversation, input.at);
      this.revalidate(conversation);
    }
    return candidates.length;
  }

  async listDueWork(input: {
    dueAt: Date;
    limit?: number;
    campaignId?: string;
    after?: { nextActionAt: Date; conversationId: string };
  }): Promise<FeedbackConversationDocument[]> {
    return [...this.documents.values()]
      .filter((conversation) => {
        const nextActionAt = conversation.work?.nextActionAt;
        if (!nextActionAt || nextActionAt > input.dueAt) return false;
        if (input.campaignId && conversation.campaignId !== input.campaignId) {
          return false;
        }
        return (
          !input.after ||
          nextActionAt > input.after.nextActionAt ||
          (nextActionAt.getTime() === input.after.nextActionAt.getTime() &&
            conversation._id > input.after.conversationId)
        );
      })
      .sort((left, right) => {
        const leftAt = left.work?.nextActionAt?.getTime() ?? 0;
        const rightAt = right.work?.nextActionAt?.getTime() ?? 0;
        return leftAt - rightAt || left._id.localeCompare(right._id);
      })
      .slice(0, input.limit ?? 50)
      .map((conversation) => structuredClone(conversation));
  }

  async beginWorkExecution(input: {
    conversationId: string;
    revision: number;
    epoch: number;
    at: Date;
  }): Promise<{
    changed: boolean;
    conversation: FeedbackConversationDocument;
    work: FeedbackConversationWork;
  }> {
    const conversation = this.require(input.conversationId);
    const current = resolveFeedbackConversationWork(conversation.work);
    const changed =
      current.nextActionAt !== null &&
      current.nextActionAt <= input.at &&
      current.revision === input.revision &&
      current.executionEpoch < input.epoch;
    if (changed) {
      conversation.work = { ...current, executionEpoch: input.epoch };
      this.revalidate(conversation);
    }
    return {
      changed,
      conversation: structuredClone(conversation),
      work: structuredClone(resolveFeedbackConversationWork(conversation.work)),
    };
  }

  async settleWorkExecution(input: {
    conversationId: string;
    revision: number;
    epoch: number;
    nextActionAt: Date | null;
    at: Date;
  }): Promise<{
    changed: boolean;
    conversation: FeedbackConversationDocument;
    work: FeedbackConversationWork;
  }> {
    const conversation = this.require(input.conversationId);
    const current = resolveFeedbackConversationWork(conversation.work);
    const changed =
      current.executionEpoch === input.epoch &&
      current.revision >= input.revision;
    if (changed && current.revision === input.revision) {
      conversation.work = {
        ...current,
        revision:
          input.nextActionAt === null ? current.revision : current.revision + 1,
        nextActionAt: input.nextActionAt,
      };
      this.revalidate(conversation);
    }
    return {
      changed,
      conversation: structuredClone(conversation),
      work: structuredClone(resolveFeedbackConversationWork(conversation.work)),
    };
  }

  async listCurrentTerminalOutboxIds(
    candidates: readonly {
      conversationId: string;
      outboxId: string;
    }[],
  ): Promise<string[]> {
    return candidates.flatMap((candidate) => {
      const conversation = this.documents.get(candidate.conversationId);
      return conversation?.lifecycle.state === "closed" &&
        conversation.lifecycle.terminalOutboxId === candidate.outboxId
        ? [candidate.outboxId]
        : [];
    });
  }

  async listStopTerminalOutboxIdsForCampaign(
    campaignId: string,
  ): Promise<string[]> {
    return [...this.documents.values()].flatMap((conversation) =>
      conversation.campaignId === campaignId &&
      conversation.lifecycle.state === "closed" &&
      conversation.lifecycle.reason === "stopped" &&
      conversation.lifecycle.terminalOutboxId
        ? [conversation.lifecycle.terminalOutboxId]
        : [],
    );
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

    const message = feedbackConversationStoredMessageSchema.parse({
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
      await this.raiseAttention({
        conversationId: conversation._id,
        kind: "transcript_full",
        messageId: null,
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
    if (
      conversation.control.mode !== "bot" ||
      conversation.lifecycle.state !== "open"
    ) {
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

  /** The bot steps back and consumes any due wake-up without changing revision. */
  async markAwaitingHuman(input: {
    conversationId: string;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.lifecycle.state !== "open") {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    const changed =
      !conversation.awaitingHuman || conversation.work?.nextActionAt != null;
    conversation.awaitingHuman = true;
    if (conversation.work) {
      conversation.work.nextActionAt = null;
    }
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed, conversation: structuredClone(conversation) };
  }

  /**
   * Advances the hostility ladder by one rung, compare-and-set.
   *
   * The guard is the real repository's, not a simplification: it is what makes a
   * replayed extraction run leave the rung where it is, and a fake that
   * incremented unconditionally would let the suite pass over a double count
   * production would suffer.
   */
  async recordHostileTurn(input: {
    conversationId: string;
    at: Date;
    expectedCount: number;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.hostileTurns !== input.expectedCount) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.hostileTurns = input.expectedCount + 1;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async markExtractionFallbackAckSent(input: {
    conversationId: string;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.extractionFallbackAckSent) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.extractionFallbackAckSent = true;
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
    const currentWork = resolveFeedbackConversationWork(conversation.work);
    const latestParticipantSeq = conversation.messages.reduce(
      (latest, message) =>
        message.actor === "participant"
          ? Math.max(latest, message.seq)
          : latest,
      0,
    );
    conversation.work = {
      ...currentWork,
      revision: currentWork.revision + 1,
      nextActionAt:
        latestParticipantSeq > conversation.extraction.cursorSeq
          ? input.at
          : currentWork.nextActionAt,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  /**
   * The first closure wins, except that a STOP overrides a softer reason.
   *
   * Closing lowers the badge only when nothing unresolved is holding it up, as
   * the repository does: an unresolved reason survives a close and is the
   * operator's to dismiss.
   */
  async close(input: {
    conversationId: string;
    reason: FeedbackConversationLifecycleReason;
    at: Date;
    terminalOutboxId?: string | null;
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
      terminalOutboxId: input.terminalOutboxId ?? null,
    };
    if (
      conversation.needsAttention &&
      !conversation.attentionReasons.some(
        (reason) => reason.resolvedAt === null,
      )
    ) {
      conversation.needsAttention = false;
    }
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async advanceCursor(input: {
    conversationId: string;
    toSeq: number;
    at: Date;
    model?: string | null;
    serviceTier?: string | null;
    usage?: FeedbackConversationExtractionUsage;
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
      // Accumulated exactly as the aggregation pipeline accumulates it, null
      // included: a double that quietly summed through a missing component
      // would let a test pass on a total the database would never produce.
      // An absent usage is a run that called no model and leaves the total be.
      usage: input.usage
        ? accumulateFeedbackExtractionUsage(
            conversation.extraction.usage,
            input.usage,
          )
        : conversation.extraction.usage,
      serviceTier: input.serviceTier ?? null,
      // A run that moved the cursor reached the provider, so it ends the park —
      // but not the record that this person has already been apologised to once.
      parkedSince: null,
      parkedRuns: 0,
      parkedNoticeSentAt: conversation.extraction.parkedNoticeSentAt,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async advanceCursorAndClose(input: {
    conversationId: string;
    toSeq: number;
    reason: "completed" | "declined";
    terminalOutboxId: string | null;
    at: Date;
    model: string;
    serviceTier: string | null;
    usage: FeedbackConversationExtractionUsage;
    workRevision?: number;
    executionEpoch?: number;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (input.toSeq > conversation.messages.length) {
      throw new FeedbackConversationTransitionError(
        "The extraction cursor cannot pass the transcript",
      );
    }
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot" ||
      input.toSeq <= conversation.extraction.cursorSeq ||
      (input.workRevision !== undefined &&
        conversation.work?.revision !== input.workRevision) ||
      (input.executionEpoch !== undefined &&
        conversation.work?.executionEpoch !== input.executionEpoch) ||
      conversation.messages.some(
        (message) =>
          message.actor === "participant" && message.seq > input.toSeq,
      )
    ) {
      return { changed: false, conversation: structuredClone(conversation) };
    }

    await this.advanceCursor(input);
    conversation.lifecycle = {
      state: "closed",
      reason: input.reason,
      closedAt: input.at,
      terminalOutboxId: input.terminalOutboxId,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async advanceCursorAndMarkAwaitingHuman(input: {
    conversationId: string;
    toSeq: number;
    at: Date;
    model: string;
    serviceTier: string | null;
    usage: FeedbackConversationExtractionUsage;
    workRevision?: number;
    executionEpoch?: number;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (input.toSeq > conversation.messages.length) {
      throw new FeedbackConversationTransitionError(
        "The extraction cursor cannot pass the transcript",
      );
    }
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot" ||
      conversation.awaitingHuman ||
      (input.workRevision !== undefined &&
        conversation.work?.revision !== input.workRevision) ||
      (input.executionEpoch !== undefined &&
        conversation.work?.executionEpoch !== input.executionEpoch)
    ) {
      return { changed: false, conversation: structuredClone(conversation) };
    }

    if (input.toSeq > conversation.extraction.cursorSeq) {
      conversation.extraction = {
        cursorSeq: input.toSeq,
        lastRunAt: input.at,
        model: input.model,
        usage: accumulateFeedbackExtractionUsage(
          conversation.extraction.usage,
          input.usage,
        ),
        serviceTier: input.serviceTier,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: conversation.extraction.parkedNoticeSentAt,
      };
    }
    conversation.awaitingHuman = true;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  /** Keeps the first park's start time and counts every run, as the pipeline does. */
  async parkExtraction(input: {
    conversationId: string;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    conversation.extraction = {
      ...conversation.extraction,
      parkedSince: conversation.extraction.parkedSince ?? input.at,
      parkedRuns: conversation.extraction.parkedRuns + 1,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  async markExtractionParkedNoticeSent(input: {
    conversationId: string;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    if (conversation.extraction.parkedNoticeSentAt !== null) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.extraction = {
      ...conversation.extraction,
      parkedNoticeSentAt: input.at,
    };
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
  }

  /**
   * Rank-up along `pending < asked < skipped < answered`, plus the WP-9δ
   * `skipped → asked` reopen. Mirrors `canTransitionGoalStatus`.
   */
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
      if (!goal || goal.status === entry.status) {
        continue;
      }
      const reopensSkip = goal.status === "skipped" && entry.status === "asked";
      const ranksUp =
        GOAL_STATUS_RANK[entry.status] > GOAL_STATUS_RANK[goal.status];
      if (reopensSkip || ranksUp) {
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

  /**
   * Idempotent on kind + message, the way the Mongo guard filter is: a retried
   * job must not leave an operator three identical rows to dismiss.
   */
  async raiseAttention(input: {
    conversationId: string;
    kind: PostEventFeedbackAttentionReason;
    messageId: string | null;
    at: Date;
  }): Promise<FakeConversationTransition> {
    const conversation = this.require(input.conversationId);
    const standing = conversation.attentionReasons.some(
      (reason) =>
        reason.kind === input.kind &&
        reason.messageId === input.messageId &&
        reason.resolvedAt === null,
    );
    if (standing) {
      return { changed: false, conversation: structuredClone(conversation) };
    }
    conversation.attentionReasons.push({
      id: randomUUID(),
      kind: input.kind,
      messageId: input.messageId,
      at: input.at,
      resolvedAt: null,
      resolvedBy: null,
    });
    conversation.needsAttention = true;
    this.touch(conversation, input.at);
    this.revalidate(conversation);
    return { changed: true, conversation: structuredClone(conversation) };
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
  readonly venueRevisionChecks: number[] = [];
  private venue: EventVenueInput | null = null;
  private venueContextRevision = 0;

  seedVenue(
    venue: EventVenueInput | null,
    contextRevision = venue === null ? 0 : 1,
  ): void {
    if (!Number.isInteger(contextRevision) || contextRevision < 0) {
      throw new Error("Fake venue revision must be a non-negative integer");
    }
    if (venue !== null && contextRevision === 0) {
      throw new Error("A fake persisted venue must have a positive revision");
    }
    this.venue = cloneVenue(venue);
    this.venueContextRevision = contextRevision;
  }

  replaceVenue(venue: EventVenueInput): void {
    this.venue = cloneVenue(venue);
    this.venueContextRevision += 1;
  }

  disableVenue(): void {
    if (!this.venue) {
      throw new Error("Cannot disable a venue the fake event does not have");
    }
    this.venue = { ...cloneVenue(this.venue), useInFeedback: false };
    this.venueContextRevision += 1;
  }

  clearVenue(): void {
    this.venue = null;
    this.venueContextRevision += 1;
  }

  async getFeedbackVenueContext(
    _eventId: string,
  ): Promise<EventFeedbackVenueSnapshot> {
    if (!this.venue?.useInFeedback) {
      return {
        contextRevision: this.venueContextRevision,
        venue: null,
      };
    }

    return {
      contextRevision: this.venueContextRevision,
      venue: {
        label: this.venue.label,
        ...(this.venue.type === undefined ? {} : { type: this.venue.type }),
        ...(this.venue.area === undefined ? {} : { area: this.venue.area }),
        ...(this.venue.priceLevel === undefined
          ? {}
          : { priceLevel: this.venue.priceLevel }),
        ...(this.venue.priceRange === undefined
          ? {}
          : { priceRange: { ...this.venue.priceRange } }),
      },
    };
  }

  async feedbackVenueContextIsCurrent(
    _transaction: AppTransaction,
    _eventId: string,
    expectedRevision: number,
  ): Promise<boolean> {
    this.venueRevisionChecks.push(expectedRevision);
    const current = await this.getFeedbackVenueContext(_eventId);
    return (
      current.venue !== null && current.contextRevision === expectedRevision
    );
  }

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

function cloneVenue(venue: EventVenueInput): EventVenueInput;
function cloneVenue(venue: null): null;
function cloneVenue(venue: EventVenueInput | null): EventVenueInput | null;
function cloneVenue(venue: EventVenueInput | null): EventVenueInput | null {
  if (venue === null) {
    return null;
  }
  return {
    ...venue,
    ...(venue.priceRange === undefined
      ? {}
      : { priceRange: { ...venue.priceRange } }),
  };
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

  async getJob(jobId: string): Promise<
    | {
        getState: () => Promise<"waiting">;
      }
    | undefined
  > {
    return this.added.some((job) => job.jobId === jobId)
      ? { getState: async () => "waiting" }
      : undefined;
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

/** Test double for summary enqueue hooks — callers only need the close notifier. */
export function noopSummaries(): import("./summary/summary.service.js").PostEventFeedbackCampaignSummaryService {
  return {
    notifyIfLastConversationClosed: async () => undefined,
    recover: async () => ({ pending: 0, automatic: 0 }),
  } as unknown as import("./summary/summary.service.js").PostEventFeedbackCampaignSummaryService;
}
