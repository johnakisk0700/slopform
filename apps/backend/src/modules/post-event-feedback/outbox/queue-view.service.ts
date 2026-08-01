import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type {
  FeedbackCampaignStatus,
  MessageOutboxLogRow,
} from "@join-the-six/database";

import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { displayNameFor } from "../inbox/conversation.view.js";
import type { FeedbackJobData, FeedbackJobName } from "../jobs.schemas.js";
import { inspectFeedbackDeliverJob } from "./inspect-deliver-job.js";
import { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import {
  FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
  FEEDBACK_OUTBOX_RECOVERY_MS,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";
import {
  feedbackOutboxMessageLogSchema,
  type FeedbackOutboxHistoryItemView,
  type FeedbackOutboxHistoryView,
  type FeedbackOutboxMessageDeliveryView,
  type FeedbackOutboxQueueItemView,
  type FeedbackOutboxQueueView,
} from "./queue-view.schemas.js";

export class FeedbackOutboxMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Message outbox row ${id} was not found`);
    this.name = FeedbackOutboxMessageNotFoundError.name;
  }
}

/**
 * The operator read model for outbound feedback messages that have not reached
 * the participant.
 *
 * It reports; it steers nothing. No method here writes a row, adds a job or
 * touches the relay, the delivery service or the extractor.
 *
 * The load rule is the whole design. `listQueue` is polled and derives every
 * field from PostgreSQL plus one batched MongoDB read — never Redis. The single
 * queue lookup lives in `getMessageDelivery`, which serves one row an operator
 * deliberately opened, exactly as `getFeedbackConversation` may inspect the
 * extract job for the one conversation on screen.
 */
@Injectable()
export class FeedbackOutboxQueueViewService {
  private readonly logger = new Logger(FeedbackOutboxQueueViewService.name);

  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly outboundLogs: FeedbackOutboundLogRepository,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
  ) {}

  async listQueue(now = new Date()): Promise<FeedbackOutboxQueueView> {
    const [rows, totals] = await Promise.all([
      this.outbox.listUndeliveredOutbox(FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
      this.outbox.countUndeliveredOutboxByStatus(),
    ]);

    const { respondentByConversation, participantById } =
      await this.respondentContext(rows);

    const pending = totals.get("pending") ?? 0;
    const sending = totals.get("sending") ?? 0;
    const held = totals.get("held") ?? 0;
    const total = pending + sending + held;

    return {
      observedAt: now.toISOString(),
      counts: { pending, sending, held, total },
      truncated: total > rows.length,
      items: rows.map((entry): FeedbackOutboxQueueItemView => {
        const respondent = respondentByConversation.get(
          entry.row.conversationId,
        );
        const participant = respondent
          ? participantById.get(respondent.respondentParticipantId)
          : undefined;

        return {
          id: entry.row.id,
          conversationId: entry.row.conversationId,
          campaignId: entry.row.campaignId,
          eventId: entry.eventId,
          eventTitle: entry.eventTitle,
          campaignStatus: entry.campaignStatus,
          kind: entry.row.kind as FeedbackOutboxQueueItemView["kind"],
          status: entry.row.status as FeedbackOutboxQueueItemView["status"],
          deliveryStatus: entry.row
            .deliveryStatus as FeedbackOutboxQueueItemView["deliveryStatus"],
          waitingSeconds: waitingSeconds(entry.row.createdAt, now),
          respondentParticipantId: respondent?.respondentParticipantId ?? null,
          respondentDisplayName: displayNameFor(participant),
          phoneAtLaunch: respondent?.phoneAtLaunch ?? null,
          createdAt: entry.row.createdAt.toISOString(),
          updatedAt: entry.row.updatedAt.toISOString(),
        };
      }),
    };
  }

  /**
   * The history half: the newest rows of any status, each carrying the
   * decision log's origin so the list already answers «why was this written».
   * Still PostgreSQL-only — origins arrive in one batched read, and the live
   * job state stays with the opened row.
   */
  async listHistory(now = new Date()): Promise<FeedbackOutboxHistoryView> {
    const [rows, total] = await Promise.all([
      this.outbox.listRecentOutbox(FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
      this.outbox.countOutbox(),
    ]);

    const [{ respondentByConversation, participantById }, originByOutboxId] =
      await Promise.all([
        this.respondentContext(rows),
        this.outboundLogs.findLogOriginsByOutboxIds(
          rows.map((entry) => entry.row.id),
        ),
      ]);

    return {
      observedAt: now.toISOString(),
      total,
      truncated: total > rows.length,
      items: rows.map((entry): FeedbackOutboxHistoryItemView => {
        const respondent = respondentByConversation.get(
          entry.row.conversationId,
        );
        const participant = respondent
          ? participantById.get(respondent.respondentParticipantId)
          : undefined;

        return {
          id: entry.row.id,
          conversationId: entry.row.conversationId,
          campaignId: entry.row.campaignId,
          eventId: entry.eventId,
          eventTitle: entry.eventTitle,
          campaignStatus: entry.campaignStatus,
          kind: entry.row.kind as FeedbackOutboxHistoryItemView["kind"],
          status: entry.row.status as FeedbackOutboxHistoryItemView["status"],
          deliveryStatus: entry.row
            .deliveryStatus as FeedbackOutboxHistoryItemView["deliveryStatus"],
          origin: originByOutboxId.get(entry.row.id) ?? null,
          respondentParticipantId: respondent?.respondentParticipantId ?? null,
          respondentDisplayName: displayNameFor(participant),
          phoneAtLaunch: respondent?.phoneAtLaunch ?? null,
          createdAt: entry.row.createdAt.toISOString(),
          updatedAt: entry.row.updatedAt.toISOString(),
        };
      }),
    };
  }

  /** One batched MongoDB + participant read for a page of outbox rows. */
  private async respondentContext(
    rows: readonly { readonly row: { readonly conversationId: string } }[],
  ) {
    const respondents = await this.conversations.listRespondentsByIds(
      rows.map((entry) => entry.row.conversationId),
    );
    const respondentByConversation = new Map(
      respondents.map((respondent) => [respondent._id, respondent]),
    );
    const participantRows = await this.participants.findByIds(
      respondents.map((respondent) => respondent.respondentParticipantId),
    );
    const participantById = new Map(
      participantRows.map((participant) => [participant.id, participant]),
    );

    return { respondentByConversation, participantById };
  }

  /**
   * One opened row: its durable status and timestamps, the live state of its
   * delivery job, and the decision log that produced it when one exists.
   *
   * Any status is accepted, not only the undelivered three. A row that reached
   * the participant between two polls of the list should answer with what
   * happened to it rather than a 404 that reads like a bug.
   */
  async getMessageDelivery(
    outboxId: string,
    now = new Date(),
  ): Promise<FeedbackOutboxMessageDeliveryView> {
    const row = await this.outbox.findOutboxById(outboxId);
    if (!row) {
      throw new FeedbackOutboxMessageNotFoundError(outboxId);
    }

    const [campaign, job, logRow] = await Promise.all([
      this.campaigns.findCampaignById(row.campaignId),
      inspectFeedbackDeliverJob(this.queue, row.id),
      this.outboundLogs.findLogByOutboxId(outboxId),
    ]);

    return {
      id: row.id,
      conversationId: row.conversationId,
      campaignId: row.campaignId,
      // The FK is `on delete restrict`, so the campaign is always there; the
      // fallback exists because the column is untyped `text`, not because a
      // row can be orphaned.
      campaignStatus: (campaign?.status ?? "closed") as FeedbackCampaignStatus,
      kind: row.kind as FeedbackOutboxMessageDeliveryView["kind"],
      status: row.status as FeedbackOutboxMessageDeliveryView["status"],
      deliveryStatus:
        row.deliveryStatus as FeedbackOutboxMessageDeliveryView["deliveryStatus"],
      observedAt: now.toISOString(),
      waitingSeconds: waitingSeconds(row.createdAt, now),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deliveryUpdatedAt: row.deliveryUpdatedAt?.toISOString() ?? null,
      sentAt: row.sentAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      playedAt: row.playedAt?.toISOString() ?? null,
      providerLogId: row.providerLogId,
      providerMessageId: row.providerMessageId,
      // The relay reclaims a `sending` row this long after its last update, so
      // an operator staring at a job that never reported back can be told when
      // recovery takes over instead of being left to guess.
      reclaimAt:
        row.status === "sending"
          ? new Date(
              row.updatedAt.getTime() + FEEDBACK_OUTBOX_RECOVERY_MS,
            ).toISOString()
          : null,
      job: {
        id: job.jobId,
        state: job.state,
        attemptsMade: job.attemptsMade,
        attemptsAllowed: job.attemptsAllowed,
        enqueuedAt: job.enqueuedAt?.toISOString() ?? null,
        dueAt: job.dueAt?.toISOString() ?? null,
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        failedReason: job.failedReason,
      },
      log: this.readOutboundLog(logRow),
    };
  }

  /**
   * A drifted jsonb payload must not 500 the operator screen. Absence and
   * unreadable history are both `null`; the warn is how we notice the latter.
   */
  private readOutboundLog(
    row: MessageOutboxLogRow | undefined,
  ): FeedbackOutboxMessageDeliveryView["log"] {
    if (!row) {
      return null;
    }

    const parsed = feedbackOutboxMessageLogSchema.safeParse({
      origin: row.origin,
      correlationId: row.correlationId,
      decision: row.decision,
      conversationState: row.conversationState,
      createdAt: row.createdAt.toISOString(),
    });

    if (!parsed.success) {
      this.logger.warn({
        event: "feedback.outbox.log_unreadable",
        outboxId: row.outboxId,
        issues: parsed.error.issues.length,
      });
      return null;
    }

    return parsed.data;
  }
}

function waitingSeconds(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 1000));
}
