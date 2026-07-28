import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { FeedbackExtractionMeta } from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type {
  FeedbackConversationDocument,
  FeedbackConversationGoal,
} from "../post-event-feedback-conversation.document.js";
import { EventsService } from "../../events/events.service.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import type { FeedbackExtractionFailureCause } from "./model.service.js";
import {
  FEEDBACK_EXTRACTION_PARK_NOTICE_AFTER_MS,
  POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE,
  POST_EVENT_FEEDBACK_FALLBACK_ACK,
  POST_EVENT_FEEDBACK_FALLBACK_FENCE_BODY,
  POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT,
  createFeedbackExtractionParkedNoticeDedupeKey,
  createFeedbackFallbackAckDedupeKey,
  createFeedbackFallbackDedupeKey,
} from "./extraction.schemas.js";
import {
  FEEDBACK_EXTRACTION_PARK_MAX_MS,
  FEEDBACK_EXTRACTION_PARK_RETRY_MS,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  createFeedbackExtractParkedJobId,
  feedbackExtractJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
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

export interface FeedbackExtractionParkResult {
  readonly parked: boolean;
  /** The retry this park queued, or absent when the ceiling is reached. */
  readonly retryJobId?: string;
  /** The one participant-facing notice, on the run that decided to send it. */
  readonly noticeOutboxId?: string;
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
 *
 * **`apply` is not for every dead run.** It answers the question «what did this
 * conversation defeat us with», and that question only makes sense when the
 * answer is about this conversation: a content filter, a schema nothing
 * satisfied, a validation refusal. A provider incident is not that — it is one
 * fault shared by every open conversation at once — and it goes to `park`
 * instead, which speaks to nobody and asks for nobody. The processor decides
 * which, from the failure's own structure.
 */
@Injectable()
export class PostEventFeedbackExtractionFallback {
  private readonly logger = new Logger(
    PostEventFeedbackExtractionFallback.name,
  );

  constructor(
    // The park path queues its own next attempt, because the queue's five-attempt
    // ladder is spent in twenty seconds and an outage is not.
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
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
      await this.raiseAttention(conversation, input, [], null);
      return { applied: false };
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      await this.raiseAttention(conversation, input, [], testimony.id);
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

      // The per-testimony fence absorbs replays of the same dead run. The row is
      // never delivered; it exists so note, audit and alert are not duplicated.
      const fenced = await this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: campaign.id,
        kind: "system",
        body: POST_EVENT_FEEDBACK_FALLBACK_FENCE_BODY,
        status: "cancelled",
        dedupeKey: createFeedbackFallbackDedupeKey(
          conversation._id,
          testimony.seq,
        ),
      });
      if (!fenced.inserted) {
        return { replayed: true as const, ackOutbox: null, note: null };
      }

      let ackOutbox: typeof fenced.row | null = null;
      if (!conversation.extractionFallbackAckSent) {
        const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
          conversationId: conversation._id,
          campaignId: campaign.id,
          kind: "reply",
          body: buildFallbackReply(conversation.goals),
          dedupeKey: createFeedbackFallbackAckDedupeKey(conversation._id),
        });
        if (enqueued.inserted) {
          ackOutbox = enqueued.row;
        }
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
          outboxId: ackOutbox?.id ?? null,
          subjectResolved: subjectParticipantId !== null,
        },
      });

      return { ackOutbox, note, replayed: false as const };
    });

    if (written.replayed) {
      // No outbox id to name. The fence row exists, but it is a cancelled
      // system row that will never be delivered, and reporting it as the
      // fallback's outbox would read as «we sent this» to every caller and log
      // line downstream. The ack, if one was ever sent, belongs to the run that
      // sent it.
      return { applied: false };
    }

    if (written.ackOutbox) {
      await this.conversations.markExtractionFallbackAckSent({
        conversationId: conversation._id,
        at: new Date(),
      });
      // Same forward-repair contract as an ordinary run: PostgreSQL is durable
      // first, the transcript entry is idempotent by `outboxId`, and the delivery
      // job repeats it before sending if this crashed.
      await this.outboundTranscript.record(
        written.ackOutbox,
        new Date(),
        input.correlationId,
      );
    }

    await this.raiseAttention(conversation, input, [input.cause], testimony.id);

    this.logger.warn({
      event: "feedback.extract.fallback_applied",
      correlationId: input.correlationId,
      conversationId: conversation._id,
      cause: input.cause,
      noteId: written.note.id,
      outboxId: written.ackOutbox?.id,
      subjectResolved: subjectParticipantId !== null,
    });

    return {
      applied: true,
      noteId: written.note.id,
      // Absent rather than undefined: the acknowledgement is sent once per
      // conversation, so every dead run after the first has no outbox of its
      // own, and `exactOptionalPropertyTypes` is the compiler holding us to the
      // difference between «no id» and «an id that is undefined».
      ...(written.ackOutbox ? { outboxId: written.ackOutbox.id } : {}),
      subjectParticipantId,
    };
  }

  /**
   * What happens instead when the provider, not the conversation, is the problem.
   *
   * Nothing is said to the participant, nothing is filed, and no attention is
   * raised. A provider incident is one event: an exhausted balance, an
   * unreachable route, a model id nobody serves. Treating each affected
   * conversation as its own failure produced the 2026-07-27 inbox, where all
   * thirty-six rows demanded a human for a fault none of them had caused and all
   * thirty-six participants were told the analysis of their evening had failed.
   *
   * What it does instead is keep trying and keep count. The conversation is
   * parked — a durable state the campaign summary counts once and the detail
   * pane reads as «waiting on the model» — and the next attempt is queued five
   * minutes out, because the queue's own ladder is twenty seconds long and this
   * class of fault is repaired in minutes. When somebody tops the account up, the
   * next wake-up reads the testimony properly and the park clears itself.
   *
   * The one thing it will say is the half-hour notice, and only once. See
   * `POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE` for every constraint on that
   * sentence; the decision to send it is the owner's, over two hours and over
   * never.
   */
  async park(
    input: FeedbackExtractionFallbackInput,
  ): Promise<FeedbackExtractionParkResult> {
    const existing = await this.conversations.findById(input.conversationId);
    if (!existing) {
      // The job is already failing and there is nothing left to park.
      this.logger.warn({
        event: "feedback.extract.park_conversation_missing",
        correlationId: input.correlationId,
        conversationId: input.conversationId,
      });
      return { parked: false };
    }

    const at = new Date();
    const parked = await this.conversations.parkExtraction({
      conversationId: input.conversationId,
      at,
    });
    const conversation = parked.conversation;
    const since = conversation.extraction.parkedSince ?? at;

    // The audit row is the durable per-conversation record of the incident, and
    // it is the only per-conversation effect: an operator alert here would page
    // once per affected conversation, which is the fan-out this whole path
    // exists to stop.
    await this.database.transaction(async (transaction) => {
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
    });

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
   * The half-hour sentence, sent at most once and only while the bot still has
   * the floor.
   *
   * The threshold is measured from `parkedSince` rather than from the
   * participant's last message on purpose: a second message during the same
   * outage must not postpone the apology for the first one, which is exactly what
   * measuring silence would do.
   *
   * It yields to `extractionFallbackAckSent`. That flag means a deterministic
   * fallback has already spoken in this conversation, and two machine apologies
   * for the same silence is one too many. The reverse is not guarded, because the
   * fallback's line carries the open question and is what keeps the
   * questionnaire moving.
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
    // A closed conversation, one a person is holding, and one waiting for a
    // person are all conversations the bot must not speak in. The park does not
    // change that, and none of the three is left worse off by our silence: two
    // have a human, and the third has ended.
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

    const enqueued = await this.database.transaction((transaction) =>
      this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        kind: "system",
        body: POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE,
        dedupeKey: createFeedbackExtractionParkedNoticeDedupeKey(
          conversation._id,
        ),
      }),
    );
    // Marked whether or not this run inserted the row: if a concurrent parked run
    // got there first, the send has happened and the ledger should say so.
    await this.conversations.markExtractionParkedNoticeSent({
      conversationId: conversation._id,
      at,
    });
    if (!enqueued.inserted) {
      return undefined;
    }
    // Same forward-repair contract as every other outbound: PostgreSQL is
    // durable first, and the transcript entry is idempotent by `outboxId`.
    await this.outboundTranscript.record(enqueued.row, at, input.correlationId);
    return enqueued.row.id;
  }

  /**
   * Queues the next attempt, which is the whole of «the retry ladder still runs».
   *
   * Bounded by `FEEDBACK_EXTRACTION_PARK_MAX_MS` so a fault nobody is repairing
   * — a model id that does not exist, a key that will never be replaced — stops
   * billing a request every five minutes. Reaching the ceiling changes nothing
   * the participant sees; the conversation stays parked and stays counted.
   *
   * A closed conversation is not re-queued: the run would exit on
   * `skipped_closed` anyway, and enqueueing work that is certain to do nothing
   * makes the queue lie about what is outstanding. Human control is deliberately
   * *not* excluded — the person may hand back, and the resume path re-queues from
   * the cursor exactly as it does today.
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
    const latestSeq = latestParticipantMessage(conversation)?.seq;
    if (latestSeq === undefined) {
      return undefined;
    }

    const data = feedbackExtractJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      conversationId: conversation._id,
      correlationId: input.correlationId,
    });
    const jobId = createFeedbackExtractParkedJobId(
      conversation._id,
      latestSeq,
      conversation.extraction.parkedRuns,
    );
    // One attempt, because this *is* the retry and the next one is queued by the
    // next park. `removeOnFail` keeps a long outage from leaving one retained
    // failed job per five minutes per conversation in Redis.
    await this.queue.add(FEEDBACK_JOB_NAMES.extractV1, data, {
      jobId,
      delay: FEEDBACK_EXTRACTION_PARK_RETRY_MS,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
      stackTraceLimit: 10,
    });
    return jobId;
  }

  /**
   * The badge, named. `extraction_failed` is what the operator has to act on:
   * this burst produced no structured answers, so whatever the participant said
   * in it is theirs to read and record by hand.
   *
   * Anchored on the testimony the dead run was reading, which is the message
   * they will want open. A run that never had a participant turn has nothing to
   * point at and says so with a null anchor rather than guessing.
   */
  private async raiseAttention(
    conversation: FeedbackConversationDocument,
    input: FeedbackExtractionFallbackInput,
    detail: readonly string[],
    messageId: string | null,
  ): Promise<void> {
    const attention = await this.conversations.raiseAttention({
      conversationId: conversation._id,
      kind: "extraction_failed",
      messageId,
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
