import { Injectable, Logger } from "@nestjs/common";
import type { MessageOutboxLogRow } from "@join-the-six/database";

import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { displayNameFor } from "../inbox/conversation.view.js";
import {
  decodeOutboxHistoryCursor,
  encodeOutboxHistoryCursor,
} from "./history-cursor.js";
import { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import {
  FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
  FeedbackOutboxRepository,
  type FeedbackOutboxHistoryFilter,
} from "./outbox.repository.js";
import {
  feedbackOutboxMessageLogSchema,
  FEEDBACK_OUTBOX_HISTORY_PAGE_SIZE,
  type FeedbackOutboxHistoryItemView,
  type FeedbackOutboxHistoryQuery,
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
 * touches a dispatcher, legacy delivery service or extractor.
 *
 * Every method derives its state from PostgreSQL plus bounded MongoDB identity
 * reads. BullMQ is no longer part of this read model: an ephemeral job could
 * not prove whether a provider attempt happened, while the dispatcher columns
 * are the recovery protocol itself.
 */
@Injectable()
export class FeedbackOutboxQueueViewService {
  private readonly logger = new Logger(FeedbackOutboxQueueViewService.name);

  constructor(
    private readonly outbox: FeedbackOutboxRepository,
    private readonly outboundLogs: FeedbackOutboundLogRepository,
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
    const claimed = totals.get("claimed") ?? 0;
    const attempting = totals.get("attempting") ?? 0;
    const ambiguous = totals.get("ambiguous") ?? 0;
    const sending = totals.get("sending") ?? 0;
    const held = totals.get("held") ?? 0;
    const total = pending + claimed + attempting + ambiguous + sending + held;

    return {
      observedAt: now.toISOString(),
      counts: {
        pending,
        claimed,
        attempting,
        ambiguous,
        sending,
        held,
        total,
      },
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
   * One page of the history: rows of any status matching the caller's filter,
   * newest first, each carrying the decision log's origin so the list already
   * answers «why was this written». Still PostgreSQL-only — origins arrive in
   * one batched read and dispatch state lives on the outbox row itself.
   *
   * The page is read one row longer than the caller asked for. That extra row
   * is never returned; it exists only to answer «is there more», which is the
   * difference between an «older» button that is honest and one that offers a
   * page it then has to admit is empty.
   */
  async listHistory(
    query: FeedbackOutboxHistoryQuery = {
      limit: FEEDBACK_OUTBOX_HISTORY_PAGE_SIZE,
    },
    now = new Date(),
  ): Promise<FeedbackOutboxHistoryView> {
    const filter: FeedbackOutboxHistoryFilter = {
      status: query.status ?? null,
      from: query.from === undefined ? null : new Date(query.from),
      to: query.to === undefined ? null : new Date(query.to),
    };
    // An unreadable cursor rewinds to the newest page rather than failing: it
    // reaches us from a URL a person can edit, and this endpoint only reads.
    const cursor =
      query.cursor === undefined
        ? null
        : decodeOutboxHistoryCursor(query.cursor);

    const [page, total] = await Promise.all([
      this.outbox.listRecentOutbox({
        limit: Math.min(query.limit + 1, FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
        filter,
        cursor,
      }),
      this.outbox.countOutbox(filter),
    ]);

    const rows = page.slice(0, query.limit);
    const last = rows.at(-1);
    const nextCursor =
      page.length > rows.length && last !== undefined
        ? encodeOutboxHistoryCursor({
            createdAt: last.row.createdAt,
            id: last.row.id,
          })
        : null;

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
      nextCursor,
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
   * One opened row: its durable dispatch status and timestamps, plus the
   * decision log that produced it when one exists.
   *
   * Any status is accepted, not only the undelivered states. A row that reached
   * the participant between two polls of the list should answer with what
   * happened to it rather than a 404 that reads like a bug.
   */
  async getMessageDelivery(
    outboxId: string,
    now = new Date(),
  ): Promise<FeedbackOutboxMessageDeliveryView> {
    const entry = await this.outbox.findOutboxWithContextById(outboxId);
    if (!entry) {
      throw new FeedbackOutboxMessageNotFoundError(outboxId);
    }
    const row = entry.row;

    const [logRow, { respondentByConversation, participantById }] =
      await Promise.all([
        this.outboundLogs.findLogByOutboxId(outboxId),
        // The same batched pair the lists spend on a whole page, here for one
        // row. This is the deliberate path — an operator opened it — and it is
        // what lets the pane name the person the message was written to.
        this.respondentContext([entry]),
      ]);

    const respondent = respondentByConversation.get(row.conversationId);
    const participant = respondent
      ? participantById.get(respondent.respondentParticipantId)
      : undefined;

    return {
      id: row.id,
      conversationId: row.conversationId,
      campaignId: row.campaignId,
      campaignStatus: entry.campaignStatus,
      eventTitle: entry.eventTitle,
      respondentDisplayName: displayNameFor(participant),
      phoneAtLaunch: respondent?.phoneAtLaunch ?? null,
      kind: row.kind as FeedbackOutboxMessageDeliveryView["kind"],
      body: row.body,
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
      dispatch: {
        state:
          row.status as FeedbackOutboxMessageDeliveryView["dispatch"]["state"],
        claimExpiresAt: row.claimExpiresAt?.toISOString() ?? null,
        sendStartedAt: row.sendStartedAt?.toISOString() ?? null,
        attemptCount: row.attemptCount,
        lastError: row.lastError,
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
