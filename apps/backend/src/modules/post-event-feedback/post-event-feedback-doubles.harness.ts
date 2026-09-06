import { randomUUID } from "node:crypto";

import type { AppTransaction, AuditEventInsert } from "@slopform/database";

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
  FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  buildFeedbackConversationGoals,
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
import {
  applyAdvanceCursor,
  applyAdvanceCursorAndClose,
  applyAdvanceCursorAndMarkAwaitingHuman,
  applyAppendMessage,
  applyClose,
  applyMarkAwaitingHuman,
  applyMarkExtractionFallbackAckSent,
  applyMarkExtractionParkedNoticeSent,
  applyMarkReminded,
  applyMarkWorkDue,
  applyMergeMessageAttention,
  applyParkExtraction,
  applyRaiseAttention,
  applyRecordHostileTurn,
  applyResolveAttentionReason,
  applyResumeBot,
  applySettleWorkExecution,
  applyTakeOver,
  applyUpdateGoalStatuses,
  type FeedbackConversationExpectedWork,
  type FeedbackConversationTransitionResult,
} from "./post-event-feedback-conversation.state.js";
import type { FeedbackOperatorAlertInput } from "./operator-alert.js";
import type { FeedbackOutboundDecision } from "./outbox/outbound-log.schemas.js";
import type { OutboundConversationSnapshot } from "./outbox/outbound-log.snapshot.js";
import type {
  FeedbackTransport,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./outbox/transport.js";
import type {
  PostEventFeedbackAttentionReason,
  PostEventFeedbackRecommendedAction,
  PostEventFeedbackSafetyCategory,
} from "./attention.js";

/**
 * The faked seams of the post-event feedback loop: the conversation row and
 * relational tables, the
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
 * capacity cap and the partial unique index on an open conversation's phone
 * are all real here. Conversation transitions call the production state
 * functions; this class keeps storage, query, capacity and fence inputs.
 */

/** Mirrors `createQueueProducerOptions`, which is where the real default lives. */
export const FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS = 5;

const TRANSACTION = { fake: "transaction" } as unknown as AppTransaction;
export const FAKE_FEEDBACK_TRANSACTION: AppTransaction = TRANSACTION;

function leadingInput<T>(
  transactionOrInput: AppTransaction | T,
  maybeInput?: T,
): T {
  return (maybeInput ?? transactionOrInput) as T;
}

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
  dispatchContext?: unknown;
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
      dispatchContext?: unknown;
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
      ...(input.dispatchContext === undefined
        ? {}
        : { dispatchContext: input.dispatchContext }),
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
    _transaction: AppTransaction,
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

const DEFAULT_FIXTURE_CAMPAIGN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const DEFAULT_FIXTURE_RESPONDENT_ID = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const defaultFixtureWork = {
  revision: 0,
  nextActionAt: null,
  executionEpoch: 0,
} as const;

/** Typed conversation seed for workflow specs. Nested patches keep defaults. */
export function feedbackConversationFixture(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  const createdAt = overrides.createdAt ?? new Date("2026-07-25T10:00:00.000Z");
  const latestMessageAt = (overrides.messages ?? []).reduce(
    (latest, message) => (message.at > latest ? message.at : latest),
    createdAt,
  );
  const base: FeedbackConversationDocument = {
    _id: overrides._id ?? randomUUID(),
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId: overrides.campaignId ?? DEFAULT_FIXTURE_CAMPAIGN_ID,
    respondentParticipantId:
      overrides.respondentParticipantId ?? DEFAULT_FIXTURE_RESPONDENT_ID,
    phoneAtLaunch: overrides.phoneAtLaunch ?? "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
    goals: buildFeedbackConversationGoals(),
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
    work: defaultFixtureWork,
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    createdAt,
    updatedAt: overrides.updatedAt ?? latestMessageAt,
  };
  const workPatch = overrides.work;
  return {
    ...base,
    ...overrides,
    lifecycle: { ...base.lifecycle, ...overrides.lifecycle },
    control: { ...base.control, ...overrides.control },
    extraction: { ...base.extraction, ...overrides.extraction },
    work: workPatch
      ? {
          revision: workPatch.revision ?? defaultFixtureWork.revision,
          nextActionAt:
            workPatch.nextActionAt === undefined
              ? defaultFixtureWork.nextActionAt
              : workPatch.nextActionAt,
          executionEpoch:
            workPatch.executionEpoch ?? defaultFixtureWork.executionEpoch,
          ...(workPatch.campaignResumeGeneration === undefined
            ? {}
            : {
                campaignResumeGeneration: workPatch.campaignResumeGeneration,
              }),
        }
      : defaultFixtureWork,
  };
}

/** Stored-message shape production appends persist, including provenance. */
export function feedbackStoredMessage(input: {
  readonly id?: string;
  readonly seq: number;
  readonly actor: FeedbackConversationMessage["actor"];
  readonly text: string;
  readonly at?: Date;
  readonly providerMessageId?: string | null;
  readonly ingressId?: string | null;
  readonly outboxId?: string | null;
  readonly attention?: FeedbackConversationMessage["attention"];
}): FeedbackConversationMessage {
  return {
    id: input.id ?? randomUUID(),
    seq: input.seq,
    actor: input.actor,
    text: input.text,
    providerMessageId: input.providerMessageId ?? null,
    ingressId:
      input.ingressId !== undefined
        ? input.ingressId
        : input.actor === "participant"
          ? randomUUID()
          : null,
    outboxId:
      input.outboxId !== undefined
        ? input.outboxId
        : input.actor === "bot"
          ? randomUUID()
          : null,
    attention: input.attention ?? null,
    at: input.at ?? new Date("2026-07-25T10:00:00.000Z"),
  };
}

/**
 * In-memory conversation store used by workflow specs. Mutations go through
 * the production state transitions. Persistence, capacity, phone uniqueness
 * and explicit fence inputs stay here so a scenario can still race or query
 * without a second state machine.
 */
export class FakeFeedbackConversations {
  readonly documents = new Map<string, FeedbackConversationDocument>();
  /**
   * Simulated `feedback_conversation_executions` row. Presence is independent
   * of `work.executionEpoch` (the joined projection defaults a missing row to 0).
   */
  private readonly executionFences = new Map<string, number>();
  beforeTerminalClose?: () => void | Promise<void>;
  beforeAwaitingHuman?: () => void | Promise<void>;

  seed(document: FeedbackConversationDocument): FeedbackConversationDocument {
    const parsed = feedbackConversationDocumentSchema.parse(document);
    this.assertPhoneAvailable(parsed);
    this.documents.set(parsed._id, parsed);
    // Existing seeds that project an epoch keep a matching row so scenarios
    // do not all need an extra setExecutionFence. Clear it to model a missing row.
    if (parsed.work) {
      this.executionFences.set(parsed._id, parsed.work.executionEpoch);
    } else {
      this.executionFences.delete(parsed._id);
    }
    return parsed;
  }

  /**
   * Installs or removes the simulated execution row. `undefined` is a missing
   * row, which is not the same as a present epoch-0 row.
   */
  setExecutionFence(conversationId: string, epoch: number | undefined): void {
    if (epoch === undefined) {
      this.executionFences.delete(conversationId);
      return;
    }
    this.executionFences.set(conversationId, epoch);
  }

  /** Test-side reader. Production code never sees this. */
  get(id: string): FeedbackConversationDocument {
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
  }[] {
    return this.get(id).messages.map((message) => ({
      seq: message.seq,
      actor: message.actor,
      text: message.text,
      ingressId: message.ingressId,
      outboxId: message.outboxId,
    }));
  }

  goalStatuses(id: string): Record<string, string> {
    return Object.fromEntries(
      this.get(id).goals.map((goal) => [goal.key, goal.status]),
    );
  }

  setAllGoals(id: string, status: FeedbackConversationGoal["status"]): void {
    for (const goal of this.get(id).goals) {
      goal.status = status;
    }
  }

  setGoal(
    id: string,
    key: string,
    status: FeedbackConversationGoal["status"],
  ): void {
    const goal = this.get(id).goals.find((entry) => entry.key === key);
    if (goal) {
      goal.status = status;
    }
  }

  setLastParticipantText(id: string, text: string): void {
    const message = [...this.get(id).messages]
      .reverse()
      .find((candidate) => candidate.actor === "participant");
    if (message) {
      message.text = text;
    }
  }

  /** Test-side append through the production sort and updatedAt bound. */
  pushStored(
    id: string,
    input: Parameters<typeof feedbackStoredMessage>[0],
  ): FeedbackConversationMessage {
    const conversation = this.require(id);
    const message = feedbackStoredMessage(input);
    this.writeConversation(applyAppendMessage(conversation, message));
    return message;
  }

  /** Replaces the transcript and lifts updatedAt so the document stays parseable. */
  replaceMessages(
    id: string,
    messages: readonly FeedbackConversationMessage[],
  ): void {
    const conversation = this.require(id);
    const latestAt = messages.reduce(
      (latest, message) => (message.at > latest ? message.at : latest),
      conversation.createdAt,
    );
    this.writeConversation({
      ...conversation,
      messages: [...messages],
      updatedAt:
        conversation.updatedAt > latestAt ? conversation.updatedAt : latestAt,
    });
  }

  async createFromLaunch(
    transactionOrInput:
      | AppTransaction
      | {
          campaignId: string;
          respondentParticipantId: string;
          phoneAtLaunch: string;
          launchedAt: Date;
          goals?: readonly FeedbackConversationGoal[];
        },
    maybeInput?: {
      campaignId: string;
      respondentParticipantId: string;
      phoneAtLaunch: string;
      launchedAt: Date;
      goals?: readonly FeedbackConversationGoal[];
    },
  ): Promise<FakeConversationCreation> {
    const input = leadingInput(transactionOrInput, maybeInput);
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
    _transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument | undefined> {
    const conversation = this.documents.get(id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  async findByIdForUpdate(
    _transaction: AppTransaction,
    id: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    return this.findById(id);
  }

  async markWorkDue(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          nextActionAt: Date;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      nextActionAt: Date;
      at: Date;
    },
  ): Promise<{
    changed: boolean;
    conversation: FeedbackConversationDocument;
    work: FeedbackConversationWork;
  }> {
    const input = leadingInput(transactionOrInput, maybeInput);
    const updated = applyMarkWorkDue(
      this.require(input.conversationId),
      input.nextActionAt,
      input.at,
    );
    return this.persistWorkTransition({ changed: true, conversation: updated });
  }

  async markCampaignWorkDue(
    _transaction: AppTransaction,
    input: {
      campaignId: string;
      nextActionAt: Date;
      at: Date;
    },
  ): Promise<number> {
    let count = 0;
    for (const conversation of [...this.documents.values()]) {
      if (
        conversation.campaignId !== input.campaignId ||
        conversation.lifecycle.state !== "open"
      ) {
        continue;
      }
      const updated = applyMarkWorkDue(
        conversation,
        input.nextActionAt,
        input.at,
      );
      const work = resolveFeedbackConversationWork(updated.work);
      this.writeConversation({
        ...updated,
        work: {
          ...work,
          campaignResumeGeneration: (work.campaignResumeGeneration ?? 0) + 1,
        },
      });
      count += 1;
    }
    return count;
  }

  async listDueWork(
    input: {
      dueAt: Date;
      limit?: number;
      campaignId?: string;
      after?: { nextActionAt: Date; conversationId: string };
    },
    _transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument[]> {
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

  async settleWorkExecution(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          revision: number;
          epoch: number;
          nextActionAt: Date | null;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      revision: number;
      epoch: number;
      nextActionAt: Date | null;
      at: Date;
    },
  ): Promise<{
    changed: boolean;
    conversation: FeedbackConversationDocument;
    work: FeedbackConversationWork;
  }> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistWorkTransition(
      applySettleWorkExecution(this.require(input.conversationId), {
        revision: input.revision,
        nextActionAt: input.nextActionAt,
        at: input.at,
      }),
    );
  }

  async listCurrentTerminalOutboxIds(
    candidates: readonly {
      conversationId: string;
      outboxId: string;
    }[],
    _transaction?: AppTransaction,
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
    _transaction?: AppTransaction,
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
    _transaction?: AppTransaction,
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
    _transaction?: AppTransaction,
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
    _limit?: number,
    _transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument[]> {
    return [...this.documents.values()]
      .filter((candidate) => candidate.campaignId === campaignId)
      .map((candidate) => structuredClone(candidate));
  }

  async appendMessage(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          actor: FeedbackConversationMessage["actor"];
          text: string;
          at: Date;
          id?: string;
          providerMessageId?: string | null;
          ingressId?: string | null;
          outboxId?: string | null;
        },
    maybeInput?: {
      conversationId: string;
      actor: FeedbackConversationMessage["actor"];
      text: string;
      at: Date;
      id?: string;
      providerMessageId?: string | null;
      ingressId?: string | null;
      outboxId?: string | null;
    },
  ): Promise<FakeConversationAppend> {
    const input = leadingInput(transactionOrInput, maybeInput);
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

    // `seq` is assigned on arrival and is deliberately not renumbered — the
    // extraction cursor is a `seq` and must not be reshuffled underneath a run.
    this.writeConversation(applyAppendMessage(conversation, message));
    return {
      appended: true,
      message,
      conversation: structuredClone(this.require(conversation._id)),
    };
  }

  async mergeMessageAttention(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          messageId: string;
          categories: readonly PostEventFeedbackSafetyCategory[];
          recommendedAction: PostEventFeedbackRecommendedAction;
          confidence: number;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      messageId: string;
      categories: readonly PostEventFeedbackSafetyCategory[];
      recommendedAction: PostEventFeedbackRecommendedAction;
      confidence: number;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    const current = this.require(input.conversationId);
    const result = applyMergeMessageAttention(current, {
      messageId: input.messageId,
      categories: input.categories,
      recommendedAction: input.recommendedAction,
      confidence: input.confidence,
      at: input.at,
    });
    if (
      result.changed &&
      this.messagesExceedCapacity(result.conversation.messages)
    ) {
      await this.raiseAttention({
        conversationId: current._id,
        kind: "transcript_full",
        messageId: null,
        at: input.at,
      });
      throw new FeedbackConversationCapacityError();
    }
    return this.persistTransition(result);
  }

  async takeOver(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          source: "staff_action" | "external_outbound";
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      source: "staff_action" | "external_outbound";
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyTakeOver(this.require(input.conversationId), {
        source: input.source,
        at: input.at,
      }),
    );
  }

  /** The bot steps back and consumes any due wake-up without changing revision. */
  async markAwaitingHuman(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyMarkAwaitingHuman(this.require(input.conversationId), input.at),
    );
  }

  /**
   * Advances the hostility ladder by one rung, compare-and-set.
   *
   * The guard is the real repository's, not a simplification: it is what makes a
   * replayed extraction run leave the rung where it is, and a fake that
   * incremented unconditionally would let the suite pass over a double count
   * production would suffer.
   */
  async recordHostileTurn(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
          expectedCount: number;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
      expectedCount: number;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyRecordHostileTurn(this.require(input.conversationId), {
        expectedCount: input.expectedCount,
        at: input.at,
      }),
    );
  }

  async markExtractionFallbackAckSent(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyMarkExtractionFallbackAckSent(
        this.require(input.conversationId),
        input.at,
      ),
    );
  }

  async resumeBot(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyResumeBot(this.require(input.conversationId), input.at),
    );
  }

  async close(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          reason: FeedbackConversationLifecycleReason;
          at: Date;
          terminalOutboxId?: string | null;
          staffClose?: FeedbackConversationDocument["staffClose"];
        },
    maybeInput?: {
      conversationId: string;
      reason: FeedbackConversationLifecycleReason;
      at: Date;
      terminalOutboxId?: string | null;
      staffClose?: FeedbackConversationDocument["staffClose"];
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyClose(this.require(input.conversationId), {
        reason: input.reason,
        at: input.at,
        terminalOutboxId: input.terminalOutboxId ?? null,
        staffClose: input.staffClose ?? null,
      }),
    );
  }

  async advanceCursor(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          toSeq: number;
          at: Date;
          model?: string | null;
          serviceTier?: string | null;
          usage?: FeedbackConversationExtractionUsage;
          workRevision?: number;
          executionEpoch?: number;
        },
    maybeInput?: {
      conversationId: string;
      toSeq: number;
      at: Date;
      model?: string | null;
      serviceTier?: string | null;
      usage?: FeedbackConversationExtractionUsage;
      workRevision?: number;
      executionEpoch?: number;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    const current = this.require(input.conversationId);
    return this.persistTransition(
      applyAdvanceCursor(current, {
        toSeq: input.toSeq,
        at: input.at,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.serviceTier !== undefined
          ? { serviceTier: input.serviceTier }
          : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
        ...this.cursorFence(current, input),
      }),
    );
  }

  async advanceCursorAndClose(
    transactionOrInput:
      | AppTransaction
      | {
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
        },
    maybeInput?: {
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
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    await this.beforeTerminalClose?.();
    const current = this.require(input.conversationId);
    return this.persistTransition(
      applyAdvanceCursorAndClose(current, {
        toSeq: input.toSeq,
        reason: input.reason,
        terminalOutboxId: input.terminalOutboxId,
        at: input.at,
        model: input.model,
        serviceTier: input.serviceTier,
        usage: input.usage,
        ...this.cursorFence(current, input),
      }),
    );
  }

  async advanceCursorAndMarkAwaitingHuman(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          toSeq: number;
          at: Date;
          model: string;
          serviceTier: string | null;
          usage: FeedbackConversationExtractionUsage;
          workRevision?: number;
          executionEpoch?: number;
        },
    maybeInput?: {
      conversationId: string;
      toSeq: number;
      at: Date;
      model: string;
      serviceTier: string | null;
      usage: FeedbackConversationExtractionUsage;
      workRevision?: number;
      executionEpoch?: number;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    await this.beforeAwaitingHuman?.();
    const current = this.require(input.conversationId);
    return this.persistTransition(
      applyAdvanceCursorAndMarkAwaitingHuman(current, {
        toSeq: input.toSeq,
        at: input.at,
        model: input.model,
        serviceTier: input.serviceTier,
        usage: input.usage,
        ...this.cursorFence(current, input),
      }),
    );
  }

  /** Keeps the first park's start time and counts every run, as the pipeline does. */
  async parkExtraction(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyParkExtraction(this.require(input.conversationId), input.at),
    );
  }

  async markExtractionParkedNoticeSent(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyMarkExtractionParkedNoticeSent(
        this.require(input.conversationId),
        input.at,
      ),
    );
  }

  async updateGoalStatuses(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          statuses: readonly {
            key: FeedbackConversationGoal["key"];
            status: FeedbackConversationGoal["status"];
          }[];
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      statuses: readonly {
        key: FeedbackConversationGoal["key"];
        status: FeedbackConversationGoal["status"];
      }[];
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyUpdateGoalStatuses(this.require(input.conversationId), {
        statuses: input.statuses,
        at: input.at,
      }),
    );
  }

  /**
   * Idempotent on kind + message: a retried job must not leave an operator
   * three identical rows to dismiss.
   */
  async raiseAttention(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          kind: PostEventFeedbackAttentionReason;
          messageId: string | null;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      kind: PostEventFeedbackAttentionReason;
      messageId: string | null;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyRaiseAttention(this.require(input.conversationId), {
        kind: input.kind,
        messageId: input.messageId,
        at: input.at,
      }),
    );
  }

  async markReminded(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          at: Date;
          expectedCount: number;
        },
    maybeInput?: {
      conversationId: string;
      at: Date;
      expectedCount: number;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyMarkReminded(this.require(input.conversationId), {
        expectedCount: input.expectedCount,
        at: input.at,
      }),
    );
  }

  async resolveAttentionReason(
    transactionOrInput:
      | AppTransaction
      | {
          conversationId: string;
          reasonId: string;
          resolvedBy: string;
          at: Date;
        },
    maybeInput?: {
      conversationId: string;
      reasonId: string;
      resolvedBy: string;
      at: Date;
    },
  ): Promise<FakeConversationTransition> {
    const input = leadingInput(transactionOrInput, maybeInput);
    return this.persistTransition(
      applyResolveAttentionReason(this.require(input.conversationId), {
        reasonId: input.reasonId,
        resolvedBy: input.resolvedBy,
        at: input.at,
      }),
    );
  }

  private require(id: string): FeedbackConversationDocument {
    const conversation = this.documents.get(id);
    if (!conversation) {
      throw new FeedbackConversationNotFoundError(id);
    }
    return conversation;
  }

  /**
   * Actual simulated execution-row epoch, never the caller's expected epoch
   * and never the document's joined projection alone. A missing map entry is
   * a missing row (`fenceEpoch` omitted), including when `work.executionEpoch`
   * is the default 0.
   */
  private cursorFence(
    conversation: FeedbackConversationDocument,
    input: {
      readonly workRevision?: number;
      readonly executionEpoch?: number;
    },
  ): {
    readonly expectedWork?: FeedbackConversationExpectedWork;
    readonly fenceEpoch?: number;
  } {
    if (
      input.workRevision === undefined &&
      input.executionEpoch === undefined
    ) {
      return {};
    }
    if (
      input.workRevision === undefined ||
      input.executionEpoch === undefined
    ) {
      throw new FeedbackConversationTransitionError(
        "A fenced cursor transition requires both workRevision and executionEpoch",
      );
    }
    const fenceEpoch = this.executionFences.has(conversation._id)
      ? this.executionFences.get(conversation._id)
      : undefined;
    return {
      expectedWork: {
        revision: input.workRevision,
        epoch: input.executionEpoch,
      },
      ...(fenceEpoch !== undefined ? { fenceEpoch } : {}),
    };
  }

  private persistTransition(
    result: FeedbackConversationTransitionResult,
  ): FakeConversationTransition {
    if (result.changed) {
      this.writeConversation(result.conversation);
    }
    return {
      changed: result.changed,
      conversation: structuredClone(this.require(result.conversation._id)),
    };
  }

  private persistWorkTransition(result: FeedbackConversationTransitionResult): {
    changed: boolean;
    conversation: FeedbackConversationDocument;
    work: FeedbackConversationWork;
  } {
    const persisted = this.persistTransition(result);
    return {
      ...persisted,
      work: structuredClone(
        resolveFeedbackConversationWork(persisted.conversation.work),
      ),
    };
  }

  private writeConversation(
    next: FeedbackConversationDocument,
  ): FeedbackConversationDocument {
    const parsed = feedbackConversationDocumentSchema.parse(next);
    const current = this.documents.get(parsed._id);
    if (!current) {
      this.documents.set(parsed._id, parsed);
      return parsed;
    }
    Object.assign(current, parsed);
    return current;
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
    return this.messagesExceedCapacity([...conversation.messages, message]);
  }

  /** JSON-byte stand-in. PostgreSQL still uses `pg_column_size`. */
  private messagesExceedCapacity(
    messages: readonly FeedbackConversationMessage[],
  ): boolean {
    if (messages.length > FEEDBACK_CONVERSATION_MAX_MESSAGES) {
      return true;
    }
    return (
      Buffer.byteLength(JSON.stringify(messages)) >
      FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES
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
