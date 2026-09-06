import { Inject, Injectable } from "@nestjs/common";

import { FeedbackLogger } from "../feedback-operation-log.js";
import type { FeedbackExtractionMeta } from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { EventsService } from "../../events/events.service.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { FeedbackOutboundIntentService } from "../outbox/outbound-intent.service.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import type { FeedbackExtractionFailureCause } from "./model.service.js";
import {
  FEEDBACK_EXTRACTION_PARK_NOTICE_AFTER_MS,
  POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE,
  POST_EVENT_FEEDBACK_FALLBACK_FENCE_BODY,
  POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT,
  createFeedbackExtractionParkedNoticeDedupeKey,
  createFeedbackFallbackDedupeKey,
} from "./extraction.schemas.js";
import {
  FEEDBACK_EXTRACTION_PARK_MAX_MS,
  FEEDBACK_EXTRACTION_PARK_RETRY_MS,
} from "../jobs.schemas.js";
import {
  foldPostEventFeedbackText,
  foldedTextContainsAtWordStart,
} from "../matching/fold-text.js";
import { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";

export interface FeedbackExtractionFallbackInput {
  readonly conversationId: string;
  readonly correlationId: string;
  readonly cause: FeedbackExtractionFailureCause;
}

export interface FeedbackExtractionFallbackResult {
  readonly applied: boolean;
  readonly noteId?: string;
  readonly outboxId?: string;
  readonly subjectParticipantId?: string | null;
}

export interface FeedbackExtractionParkResult {
  readonly parked: boolean;
  /** The retry this park queued, or absent when the ceiling is reached. */
  readonly retryJobId?: string;
  /** The one participant-facing notice, on the run that decided to send it. */
  readonly noticeOutboxId?: string;
}

/**
 * Deterministic fallback for a conversation-local dead run (refusal, schema,
 * validation). Leaves attention, a generic note (`origin:
 * deterministic_fallback`), and no bot message — re-asking the open goal would
 * repeat a just-supplied answer. Subject only when exactly one current D16 name
 * matches (else D18 subjectless). Provider incidents go to `park` instead.
 */
@Injectable()
export class PostEventFeedbackExtractionFallback {
  private readonly logger = new FeedbackLogger(
    PostEventFeedbackExtractionFallback.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsService,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundIntent: FeedbackOutboundIntentService,
    @Inject(FEEDBACK_OPERATOR_ALERT)
    private readonly alert: FeedbackOperatorAlert,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {}

  async apply(
    input: FeedbackExtractionFallbackInput,
  ): Promise<FeedbackExtractionFallbackResult> {
    const conversation = await this.conversations.findById(
      input.conversationId,
    );
    if (!conversation) {
      // Already failing; a missing conversation is nothing left to repair.
      this.logger.warn({
        event: "feedback.extract.fallback_conversation_missing",
        correlationId: input.correlationId,
        conversationId: input.conversationId,
      });
      return { applied: false };
    }

    const testimony = latestParticipantMessage(conversation);
    if (!testimony) {
      // No testimony: raise attention only. A note would have no provenance.
      await this.parkForHuman(conversation, input, null);
      return { applied: false };
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      await this.parkForHuman(conversation, input, testimony.id);
      return { applied: false };
    }

    const candidates = await this.events.listFeedbackCandidatesForRespondent(
      campaign.eventId,
      conversation.respondentParticipantId,
    );
    const subjectParticipantId = resolveUniqueNamedSubject(
      testimony.text,
      candidates.items,
    );

    const written = await this.database.transaction(async (transaction) => {
      // Same advisory key as dispatcher provider-entry. Brake/cancel either
      // win before transport or observe a row already past that boundary.
      await this.results.lockConversation(transaction, conversation._id);

      // Per-testimony cancelled fence: replay must not duplicate note/audit/alert.
      const fenced = await this.outboundIntent.enqueue(transaction, {
        dispatch: {
          schemaVersion: 1,
          purpose: "extraction_fallback_fence",
        },
        message: {
          conversationId: conversation._id,
          campaignId: campaign.id,
          body: POST_EVENT_FEEDBACK_FALLBACK_FENCE_BODY,
          status: "cancelled",
          dedupeKey: createFeedbackFallbackDedupeKey(
            conversation._id,
            testimony.seq,
          ),
        },
        history: {
          conversation,
          decision: {
            origin: "extraction_fallback_fence",
            cause: input.cause,
          },
          correlationId: input.correlationId,
        },
      });

      // Cancel queued questions before setting the human handoff.
      await this.conversations.markAwaitingHuman(transaction, {
        conversationId: conversation._id,
        at: new Date(),
      });
      await this.outbox.cancelQueuedAutomatedOutboxForConversation(
        transaction,
        conversation._id,
      );
      const attention = await this.conversations.raiseAttention(transaction, {
        conversationId: conversation._id,
        kind: "extraction_failed",
        messageId: testimony.id,
        at: new Date(),
      });
      if (!fenced.inserted) {
        return {
          replayed: true as const,
          note: null,
          attentionChanged: attention.changed,
        };
      }

      const note = await this.results.insertNote(transaction, {
        campaignId: campaign.id,
        conversationId: conversation._id,
        respondentParticipantId: conversation.respondentParticipantId,
        subjectParticipantId,
        noteType: "general",
        text: POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT,
        sourceMessageIds: [testimony.id],
        extractionMeta: buildFallbackExtractionMeta({
          cause: input.cause,
          candidateIds: candidates.items.map(
            (candidate) => candidate.participantId,
          ),
          subjectResolved: subjectParticipantId !== null,
        }),
        status: "new",
      });

      await this.audit.append(transaction, {
        actorType: "system",
        actorId: "feedback_extraction",
        action: "feedback_conversation.extraction_failed",
        entityType: "feedback_conversation",
        entityId: conversation._id,
        requestId: input.correlationId,
        context: {
          campaignId: conversation.campaignId,
          cause: input.cause,
          sourceMessageId: testimony.id,
          noteId: note.id,
          outboxId: null,
          subjectResolved: subjectParticipantId !== null,
        },
      });

      return {
        note,
        replayed: false as const,
        attentionChanged: attention.changed,
      };
    });

    await this.notifyAttention(conversation, input, written.attentionChanged, [
      input.cause,
    ]);

    if (written.replayed) {
      // Fence exists but is cancelled and never delivered — do not report it.
      return { applied: false };
    }

    this.logger.warn({
      event: "feedback.extract.fallback_applied",
      correlationId: input.correlationId,
      conversationId: conversation._id,
      cause: input.cause,
      noteId: written.note.id,
      subjectResolved: subjectParticipantId !== null,
    });

    return {
      applied: true,
      noteId: written.note.id,
      subjectParticipantId,
    };
  }

  /**
   * Provider incident: no note, outbound, attention or alert. Park and retry;
   * campaign summary counts parked conversations once. One half-hour notice
   * at most — see `POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE`.
   */
  async park(
    input: FeedbackExtractionFallbackInput,
  ): Promise<FeedbackExtractionParkResult> {
    const existing = await this.conversations.findById(input.conversationId);
    if (!existing) {
      // Already failing; nothing left to park.
      this.logger.warn({
        event: "feedback.extract.park_conversation_missing",
        correlationId: input.correlationId,
        conversationId: input.conversationId,
      });
      return { parked: false };
    }

    const at = new Date();
    const parked = await this.database.transaction(async (transaction) => {
      const transition = await this.conversations.parkExtraction(transaction, {
        conversationId: input.conversationId,
        at,
      });
      const conversation = transition.conversation;
      const since = conversation.extraction.parkedSince ?? at;
      await this.audit.append(transaction, {
        actorType: "system",
        actorId: "feedback_extraction",
        action: "feedback_conversation.extraction_parked",
        entityType: "feedback_conversation",
        entityId: conversation._id,
        requestId: input.correlationId,
        context: {
          campaignId: conversation.campaignId,
          cause: input.cause,
          parkedRuns: conversation.extraction.parkedRuns,
          parkedSince: since.toISOString(),
        },
      });
      return { conversation, since };
    });
    const { conversation, since } = parked;

    const notice = await this.sendParkedNotice(conversation, input, since, at);
    const retryJobId = await this.queueParkedRetry(
      conversation,
      input,
      since,
      at,
    );

    this.logger.warn({
      event: "feedback.extract.parked",
      correlationId: input.correlationId,
      conversationId: conversation._id,
      campaignId: conversation.campaignId,
      cause: input.cause,
      parkedRuns: conversation.extraction.parkedRuns,
      parkedSince: since.toISOString(),
      ...(retryJobId ? { retryJobId } : { retriesExhausted: true }),
      ...(notice ? { noticeOutboxId: notice } : {}),
    });

    return {
      parked: true,
      ...(retryJobId ? { retryJobId } : {}),
      ...(notice ? { noticeOutboxId: notice } : {}),
    };
  }

  /**
   * Half-hour notice, at most once, only while the bot still has the floor.
   * Clock starts at `parkedSince` (a later message must not postpone it).
   * Yields to legacy `extractionFallbackAckSent`.
   */
  private async sendParkedNotice(
    conversation: FeedbackConversationDocument,
    input: FeedbackExtractionFallbackInput,
    since: Date,
    at: Date,
  ): Promise<string | undefined> {
    if (
      conversation.extraction.parkedNoticeSentAt !== null ||
      conversation.extractionFallbackAckSent ||
      at.getTime() - since.getTime() < FEEDBACK_EXTRACTION_PARK_NOTICE_AFTER_MS
    ) {
      return undefined;
    }
    // Closed, human-controlled, or awaiting-human: the bot must not speak.
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot" ||
      conversation.awaitingHuman
    ) {
      return undefined;
    }
    // Nothing to apologise for not reading.
    if (!latestParticipantMessage(conversation)) {
      return undefined;
    }

    const enqueued = await this.database.transaction(async (transaction) => {
      const result = await this.outboundIntent.enqueue(transaction, {
        dispatch: {
          schemaVersion: 1,
          purpose: "extraction_parked_notice",
        },
        message: {
          conversationId: conversation._id,
          campaignId: conversation.campaignId,
          body: POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE,
          dedupeKey: createFeedbackExtractionParkedNoticeDedupeKey(
            conversation._id,
          ),
        },
        history: {
          conversation,
          decision: {
            origin: "extraction_parked_notice",
            cause: input.cause,
          },
          correlationId: input.correlationId,
        },
      });
      await this.conversations.markExtractionParkedNoticeSent(transaction, {
        conversationId: conversation._id,
        at,
      });
      if (result.inserted) {
        await this.outboundTranscript.record(
          transaction,
          result.row,
          at,
          input.correlationId,
        );
      }
      return result;
    });
    if (!enqueued.inserted) {
      return undefined;
    }
    return enqueued.row.id;
  }

  /**
   * Next parked retry, bounded by `FEEDBACK_EXTRACTION_PARK_MAX_MS`. Closed
   * conversations are not re-queued. Human control is not excluded: resume
   * re-queues from the cursor.
   */
  private async queueParkedRetry(
    conversation: FeedbackConversationDocument,
    input: FeedbackExtractionFallbackInput,
    since: Date,
    at: Date,
  ): Promise<string | undefined> {
    if (conversation.lifecycle.state !== "open") {
      return undefined;
    }
    if (at.getTime() - since.getTime() >= FEEDBACK_EXTRACTION_PARK_MAX_MS) {
      return undefined;
    }
    if (!latestParticipantMessage(conversation)) {
      return undefined;
    }

    return this.wakeups.schedule({
      conversationId: conversation._id,
      nextActionAt: new Date(at.getTime() + FEEDBACK_EXTRACTION_PARK_RETRY_MS),
      correlationId: input.correlationId,
      at,
    });
  }

  private async notifyAttention(
    conversation: FeedbackConversationDocument,
    input: FeedbackExtractionFallbackInput,
    changed: boolean,
    detail: readonly string[],
  ): Promise<void> {
    if (changed) {
      await this.alert.raise({
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        reason: "extraction_failed",
        correlationId: input.correlationId,
        detail,
      });
    }
  }

  private async parkForHuman(
    conversation: FeedbackConversationDocument,
    input: FeedbackExtractionFallbackInput,
    messageId: string | null,
  ): Promise<void> {
    const at = new Date();
    const attention = await this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, conversation._id);
      await this.conversations.markAwaitingHuman(transaction, {
        conversationId: conversation._id,
        at,
      });
      await this.outbox.cancelQueuedAutomatedOutboxForConversation(
        transaction,
        conversation._id,
      );
      return this.conversations.raiseAttention(transaction, {
        conversationId: conversation._id,
        kind: "extraction_failed",
        messageId,
        at,
      });
    });
    await this.notifyAttention(conversation, input, attention.changed, []);
  }
}

/**
 * Fallback provenance: no model or confidence (absent, not zero). Candidate
 * ids of this run stay so D16 resolution remains explainable.
 */
function buildFallbackExtractionMeta(input: {
  readonly cause: FeedbackExtractionFailureCause;
  readonly candidateIds: readonly string[];
  readonly subjectResolved: boolean;
}): FeedbackExtractionMeta {
  return {
    origin: "deterministic_fallback",
    cause: input.cause,
    candidateIds: [...input.candidateIds],
    // D18: unnamed subject is flagged for a human to finish.
    ...(input.subjectResolved ? {} : { flaggedForReview: true }),
  };
}

/**
 * Subject only when exactly one current candidate name (full or first token,
 * folded) matches. Two same first names stay subjectless (D18) — no guess.
 */
function resolveUniqueNamedSubject(
  text: string,
  candidates: readonly { participantId: string; displayName: string }[],
): string | null {
  const folded = foldPostEventFeedbackText(text);
  if (folded.length === 0) {
    return null;
  }

  const matched = new Set<string>();
  for (const candidate of candidates) {
    const foldedName = foldPostEventFeedbackText(candidate.displayName);
    if (foldedName.length === 0) {
      continue;
    }
    const firstToken = foldedName.split(" ")[0] ?? foldedName;
    if (
      foldedTextContainsAtWordStart(folded, foldedName) ||
      foldedTextContainsAtWordStart(folded, firstToken)
    ) {
      matched.add(candidate.participantId);
    }
  }

  if (matched.size !== 1) {
    return null;
  }
  const [only] = matched;
  return only ?? null;
}
