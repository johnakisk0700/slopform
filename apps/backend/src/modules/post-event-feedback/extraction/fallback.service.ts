import { Inject, Injectable, Logger } from "@nestjs/common";
import type { FeedbackExtractionMeta } from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "../../conversations/feedback-conversation.repository.js";
import type {
  FeedbackConversationDocument,
  FeedbackConversationGoal,
} from "../../conversations/feedback-conversation.schemas.js";
import { EventsService } from "../../events/events.service.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import type { FeedbackExtractionFailureCause } from "./model.service.js";
import {
  POST_EVENT_FEEDBACK_FALLBACK_ACK,
  POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT,
  createFeedbackFallbackDedupeKey,
} from "./extraction.schemas.js";
import {
  foldPostEventFeedbackText,
  foldedTextContainsAtWordStart,
} from "../matching/fold-text.js";

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

/**
 * What happens when `feedback.extract.v1` dies for good.
 *
 * The failure this exists for is not hypothetical: a participant described
 * sexual harassment, the provider refused to emit structured output, the job
 * exhausted its attempts and **nothing** was recorded — no note, no attention
 * flag, no audit trail, and a conversation frozen mid-question. The worst
 * message in the campaign produced the least evidence.
 *
 * So a permanently failed run still leaves three things behind, deterministic
 * and model-free:
 *
 * 1. `needsAttention` plus one audit event carrying a bounded cause class;
 * 2. one ordinary `feedback_notes` row — the same table, status and admin view
 *    as any other note, because D13 (amended) says safety material is visible
 *    feedback, not a separate incident record;
 * 3. one bot acknowledgement so the participant is not left on read.
 *
 * It fabricates nothing. The note text is generic (nothing was extracted, so
 * nothing may be characterised), `extraction_meta` records
 * `origin: deterministic_fallback` with no model or confidence, and the note is
 * directed at a person only when exactly one current candidate name appears in
 * the message — otherwise it stays subjectless under D18.
 */
@Injectable()
export class PostEventFeedbackExtractionFallback {
  private readonly logger = new Logger(
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
    @Inject(FEEDBACK_OPERATOR_ALERT)
    private readonly alert: FeedbackOperatorAlert,
  ) {}

  async apply(
    input: FeedbackExtractionFallbackInput,
  ): Promise<FeedbackExtractionFallbackResult> {
    const conversation = await this.conversations.findById(
      input.conversationId,
    );
    if (!conversation) {
      // The job is already failing; a missing conversation is not a second
      // failure to raise, just nothing left to repair.
      this.logger.warn({
        event: "feedback.extract.fallback_conversation_missing",
        correlationId: input.correlationId,
        conversationId: input.conversationId,
      });
      return { applied: false };
    }

    const testimony = latestParticipantMessage(conversation);
    if (!testimony) {
      // No participant turn means the run never had testimony to lose. Raise
      // attention so the dead job is visible and stop there: a note with no
      // source message would have no provenance, and an acknowledgement would
      // answer a message nobody sent.
      await this.raiseAttention(conversation, input, []);
      return { applied: false };
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      await this.raiseAttention(conversation, input, []);
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
      await this.results.lockConversation(transaction, conversation._id);

      // The outbox `dedupe_key` is the fence for the entire fallback. Insert it
      // first: if it was already there, this is a replay and the note, the
      // audit event and the alert must not happen a second time.
      const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: campaign.id,
        kind: "reply",
        body: buildFallbackReply(conversation.goals),
        dedupeKey: createFeedbackFallbackDedupeKey(
          conversation._id,
          testimony.seq,
        ),
      });
      if (!enqueued.inserted) {
        return { outbox: enqueued.row, replayed: true as const };
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
          outboxId: enqueued.row.id,
          subjectResolved: subjectParticipantId !== null,
        },
      });

      return { outbox: enqueued.row, note, replayed: false as const };
    });

    // Same forward-repair contract as an ordinary run: PostgreSQL is durable
    // first, the transcript entry is idempotent by `outboxId`, and the delivery
    // job repeats it before sending if this crashed.
    await this.outboundTranscript.record(
      written.outbox,
      new Date(),
      input.correlationId,
    );

    if (written.replayed) {
      return { applied: false, outboxId: written.outbox.id };
    }

    await this.raiseAttention(conversation, input, [input.cause]);

    this.logger.warn({
      event: "feedback.extract.fallback_applied",
      correlationId: input.correlationId,
      conversationId: conversation._id,
      cause: input.cause,
      noteId: written.note.id,
      outboxId: written.outbox.id,
      subjectResolved: subjectParticipantId !== null,
    });

    return {
      applied: true,
      noteId: written.note.id,
      outboxId: written.outbox.id,
      subjectParticipantId,
    };
  }

  private async raiseAttention(
    conversation: FeedbackConversationDocument,
    input: FeedbackExtractionFallbackInput,
    detail: readonly string[],
  ): Promise<void> {
    const attention = await this.conversations.setNeedsAttention({
      conversationId: conversation._id,
      needsAttention: true,
      at: new Date(),
    });
    if (attention.changed) {
      await this.alert.raise({
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        reason: "extraction_failed",
        correlationId: input.correlationId,
        detail,
      });
    }
  }
}

/**
 * D12's provenance contract, minus everything that would be a lie. No model ran
 * to completion and no confidence was reported, so neither field is present —
 * an absent field is honest, a zero would read as a real low-confidence
 * extraction. The candidate ids of the run are still recorded, because under
 * D16's live selection they are the only way to explain later why a name was or
 * was not resolvable.
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
    // D18: a fallback that could not name a subject is flagged for the same
    // reason a degraded extraction note is — a human has to finish the job.
    ...(input.subjectResolved ? {} : { flaggedForReview: true }),
  };
}

/**
 * A brief acknowledgement plus the question the bot was already asking, both
 * taken from copy that already exists. The point is only that the thread does
 * not dead-end: the participant answered, and something has to answer back.
 */
function buildFallbackReply(
  goals: readonly FeedbackConversationGoal[],
): string {
  const current = [...goals]
    .sort((left, right) => left.ordinal - right.ordinal)
    .find((goal) => goal.status !== "answered" && goal.status !== "skipped");

  return current
    ? `${POST_EVENT_FEEDBACK_FALLBACK_ACK} ${current.prompt}`
    : POST_EVENT_FEEDBACK_FALLBACK_ACK;
}

/**
 * Direct the note only when the message names exactly one current candidate.
 *
 * Two candidates called «Κώστας» cannot be told apart by application code —
 * both ids are valid, so a correct pick and a lucky guess are the same move.
 * The extraction prompt handles that by asking a clarifying question; a
 * deterministic fallback has no such option, so it degrades to a subjectless
 * note (D18) rather than asserting something about a real person.
 *
 * Matching is on the full display name *or* its first token, folded, so
 * «ο Κώστας» matches «Κώστας Παπαδόπουλος» — which is also precisely what makes
 * two Κώστας rows ambiguous instead of silently picking the first.
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
