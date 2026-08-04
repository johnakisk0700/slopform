import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  events,
  feedbackCampaigns,
  MESSAGE_OUTBOX_STATUSES,
  messageOutbox,
  type AppTransaction,
  type FeedbackCampaignStatus,
  type MessageOutboxDeliveryStatus,
  type MessageOutboxKind,
  type MessageOutboxRow,
  type MessageOutboxStatus,
} from "@join-the-six/database";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FEEDBACK_CONVERSATION_MAX_MESSAGES } from "../post-event-feedback-conversation.document.js";

/** Stale `sending` rows older than this are reclaimed for re-enqueue / reconcile. */
export const FEEDBACK_OUTBOX_RECOVERY_MS = 5 * 60_000;
export const FEEDBACK_OUTBOX_BATCH_SIZE = 50;
export const FEEDBACK_OUTBOX_LEGACY_AMBIGUOUS_ERROR =
  "legacy_sending_cutover_ambiguous";
const messageOutboxStatusSchema = z.enum(MESSAGE_OUTBOX_STATUSES);

/**
 * A small parallel lane count per replica.
 *
 * Claims share one lease start, so a large sequential batch can age its tail
 * before those rows even reach the provider-start limiter. Four lanes keep the
 * claim-to-marker interval bounded while replicas still scale horizontally.
 */
export const FEEDBACK_OUTBOX_DISPATCH_BATCH_SIZE = 4;
/** Longer than one bounded provider call plus normal deployment-wide pacing. */
export const FEEDBACK_OUTBOX_DISPATCH_LEASE_MS = 2 * 60_000;
/** Renews twice before a healthy pre-send lease reaches PostgreSQL expiry. */
export const FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS = Math.floor(
  FEEDBACK_OUTBOX_DISPATCH_LEASE_MS / 3,
);
/** Every state in which an older row can still affect participant reality. */
export const FEEDBACK_OUTBOX_FIFO_BLOCKING_STATUSES = [
  "pending",
  "held",
  "claimed",
  "attempting",
  "ambiguous",
  "sending",
] as const satisfies readonly MessageOutboxStatus[];

/** FIFO states an exact terminal row may never pass. */
export const FEEDBACK_OUTBOX_FIFO_LIVE_BLOCKING_STATUSES = [
  "pending",
  "held",
  "claimed",
  "attempting",
  "sending",
] as const satisfies readonly MessageOutboxStatus[];

export type FeedbackOutboxClaimedRow = MessageOutboxRow & {
  readonly status: "claimed";
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly sendStartedAt: null;
};

export interface FeedbackOutboxTerminalCandidate {
  readonly conversationId: string;
  readonly outboxId: string;
}

export interface FeedbackOutboxStatusProjection {
  readonly outboxId: string;
  readonly status: MessageOutboxStatus;
}

export type FeedbackLegacyClosingResolution =
  | { readonly outcome: "clear" }
  | {
      readonly outcome: "provider_crossed";
      readonly row: MessageOutboxRow;
    };

/**
 * The statuses that mean "written down, but the participant does not have it".
 *
 * `sent`, `failed` and `cancelled` are business-terminal. `ambiguous` is
 * execution-terminal but still undelivered: only provider evidence or an
 * operator may resolve it. `pending`, `claimed`, `attempting` and legacy
 * `sending` expose the active dispatcher/relay states; `held` is parked.
 */
export const FEEDBACK_OUTBOX_UNDELIVERED_STATUSES = [
  "pending",
  "claimed",
  "attempting",
  "ambiguous",
  "sending",
  "held",
] as const satisfies readonly MessageOutboxStatus[];

export type FeedbackUndeliveredOutboxStatus =
  (typeof FEEDBACK_OUTBOX_UNDELIVERED_STATUSES)[number];

/**
 * One undelivered outbox row with the campaign context that decides whether it
 * is stuck or deliberately parked: the relay skips any row whose campaign is
 * not `launched`, so `campaignStatus` is what separates "the system is behind"
 * from "an operator pressed pause".
 */
export interface FeedbackUndeliveredOutboxRow {
  readonly row: MessageOutboxRow;
  readonly campaignStatus: FeedbackCampaignStatus;
  readonly eventId: string;
  readonly eventTitle: string;
}

/** Upper bound on one page of the undelivered list. */
export const FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT = 200;

/**
 * Which rows of the history one page is drawn from.
 *
 * `message_outbox` is append-only and never pruned, so the history is a log
 * that outgrows any cap within a single campaign. Every field here narrows the
 * *set*; the cursor below walks it. They are separate on purpose: changing a
 * filter must restart the walk, and a page is only meaningful against the
 * filter it was cut from.
 */
export interface FeedbackOutboxHistoryFilter {
  /** One status, or null for every status the table allows. */
  readonly status: MessageOutboxStatus | null;
  /** Inclusive lower bound on `created_at`; null for «since the beginning». */
  readonly from: Date | null;
  /** Inclusive upper bound on `created_at`; null for «up to now». */
  readonly to: Date | null;
}

/**
 * Where the next page of history starts: the last row of the previous one.
 *
 * Keyset, not offset. This table is written to while an operator reads it, and
 * `OFFSET 50` against a growing log silently repeats rows it has already shown
 * and skips ones it has not — the two failure modes a log viewer must not have.
 * `id` breaks the tie because `created_at` has no uniqueness guarantee.
 */
export interface FeedbackOutboxHistoryCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export const FEEDBACK_OUTBOX_HISTORY_NO_FILTER: FeedbackOutboxHistoryFilter = {
  status: null,
  from: null,
  to: null,
};

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackOutboxRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
  ) {}

  /** Shared mutex for Mongo control transitions and the provider-entry CAS. */
  lockConversation(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<unknown> {
    return transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-conversation:${conversationId}`}, 0))`,
    );
  }

  /**
   * Enqueues an outbound message. Duplicate `dedupe_key` inserts are ignored
   * and the existing row is returned.
   */
  async insertOutboxIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly id?: string;
      readonly conversationId: string;
      readonly campaignId: string;
      readonly kind: MessageOutboxKind;
      readonly body: string;
      readonly dedupeKey: string;
      readonly status?: MessageOutboxStatus;
      readonly createdByStaff?: string | null;
    },
  ): Promise<{ readonly row: MessageOutboxRow; readonly inserted: boolean }> {
    const [inserted] = await transaction
      .insert(messageOutbox)
      .values({
        ...(input.id ? { id: input.id } : {}),
        conversationId: input.conversationId,
        campaignId: input.campaignId,
        kind: input.kind,
        body: input.body,
        dedupeKey: input.dedupeKey,
        status: input.status ?? "pending",
        createdByStaff: input.createdByStaff ?? null,
      })
      .onConflictDoNothing({
        target: [messageOutbox.dedupeKey],
      })
      .returning();

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.findOutboxByDedupeKey(
      input.dedupeKey,
      transaction,
    );

    if (!existing) {
      throw new Error(
        "Message outbox conflict did not resolve to an existing row",
      );
    }

    return { row: existing, inserted: false };
  }

  /**
   * One bounded PostgreSQL projection for the Mongo transcript's outbox ids.
   *
   * The aggregate schema caps its entire transcript at the same limit, so this
   * is one small indexed lookup rather than one query per bot turn. A missing
   * result is intentionally distinguishable from every outbox status; old
   * Mongo turns can predate the retained PostgreSQL row.
   */
  async listOutboxStatusesByIds(
    outboxIds: readonly string[],
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackOutboxStatusProjection[]> {
    const boundedIds = [...new Set(outboxIds)].slice(
      0,
      FEEDBACK_CONVERSATION_MAX_MESSAGES,
    );
    if (boundedIds.length === 0) return [];

    const rows = await executor
      .select({ outboxId: messageOutbox.id, status: messageOutbox.status })
      .from(messageOutbox)
      .where(inArray(messageOutbox.id, boundedIds));
    return rows.map((row) => ({
      outboxId: row.outboxId,
      status: messageOutboxStatusSchema.parse(row.status),
    }));
  }

  /**
   * Retires the fixed V1 closing identity before an anchored V2 close is
   * inserted, or reports that the old row has crossed the provider boundary.
   *
   * The row lock makes the decision atomic with the caller's anchored insert.
   * A pre-send row is safe to cancel. `sending` is deliberately treated as
   * crossed because the V1 relay recorded no send marker; guessing that it did
   * not send is exactly how duplicate closing copy escapes during rollout.
   */
  async resolveLegacyClosingBeforeAnchoredInsert(
    transaction: AppTransaction,
    legacyDedupeKey: string,
  ): Promise<FeedbackLegacyClosingResolution> {
    const [legacy] = await transaction
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.dedupeKey, legacyDedupeKey))
      .limit(1)
      .for("update");
    if (
      !legacy ||
      legacy.status === "failed" ||
      legacy.status === "cancelled"
    ) {
      return { outcome: "clear" };
    }

    const providerCrossed =
      legacy.status === "attempting" ||
      legacy.status === "ambiguous" ||
      legacy.status === "sending" ||
      legacy.status === "sent" ||
      legacy.sendStartedAt !== null;
    if (providerCrossed) {
      return { outcome: "provider_crossed", row: legacy };
    }

    if (
      legacy.status === "pending" ||
      legacy.status === "held" ||
      legacy.status === "claimed"
    ) {
      await transaction
        .update(messageOutbox)
        .set({
          status: "cancelled",
          claimExpiresAt: null,
          lastError: "superseded_by_anchored_closing",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(messageOutbox.id, legacy.id));
    }

    return { outcome: "clear" };
  }

  /**
   * One row with the campaign and event context the lists already join in.
   *
   * The opened row needs the same three facts a list row carries — the campaign
   * status that says whether the relay will touch it, and the event it is
   * about — and reading them as a second and third round trip would be three
   * queries for one join the index already serves.
   */
  async findOutboxWithContextById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackUndeliveredOutboxRow | undefined> {
    const [entry] = await executor
      .select({
        row: messageOutbox,
        campaignStatus: feedbackCampaigns.status,
        eventId: feedbackCampaigns.eventId,
        eventTitle: events.title,
      })
      .from(messageOutbox)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackCampaigns.id, messageOutbox.campaignId),
      )
      .innerJoin(events, eq(events.id, feedbackCampaigns.eventId))
      .where(eq(messageOutbox.id, id))
      .limit(1);

    return entry === undefined
      ? undefined
      : {
          row: entry.row,
          campaignStatus: entry.campaignStatus as FeedbackCampaignStatus,
          eventId: entry.eventId,
          eventTitle: entry.eventTitle,
        };
  }

  async findOutboxByDedupeKey(
    dedupeKey: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.dedupeKey, dedupeKey))
      .limit(1);

    return record;
  }

  async findOutboxByProviderMessageId(
    providerMessageId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.providerMessageId, providerMessageId))
      .limit(1);

    return record;
  }

  /**
   * Correlates an observed outbound message that carries no provider message id
   * yet: the oldest not-yet-linked row of that conversation with the exact same
   * body, but only after provider entry happened or cannot be ruled out.
   * `pending`/`claimed` prove our transport was not entered; treating an
   * identical staff message as ours there would suppress takeover.
   */
  async findUnlinkedOutboxByConversationAndBody(
    conversationId: string,
    body: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          eq(messageOutbox.body, body),
          isNull(messageOutbox.providerMessageId),
          inArray(messageOutbox.status, [
            "attempting",
            "ambiguous",
            "sending",
            "sent",
          ]),
        ),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(1);

    return record;
  }

  async listOutboxByConversation(
    conversationId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow[]> {
    return executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.conversationId, conversationId))
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id));
  }

  async updateOutboxStatus(
    transaction: AppTransaction,
    id: string,
    status: MessageOutboxStatus,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await transaction
      .update(messageOutbox)
      .set({ status, updatedAt: new Date() })
      .where(eq(messageOutbox.id, id))
      .returning();

    return record;
  }

  async updateOutboxDelivery(
    transaction: AppTransaction,
    id: string,
    input: {
      readonly deliveryStatus: MessageOutboxDeliveryStatus;
      readonly providerLogId?: string | null;
      readonly providerMessageId?: string | null;
      readonly sentAt?: Date | null;
      readonly deliveredAt?: Date | null;
      readonly readAt?: Date | null;
      readonly playedAt?: Date | null;
      readonly status?: MessageOutboxStatus;
    },
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await transaction
      .update(messageOutbox)
      .set({
        deliveryStatus: input.deliveryStatus,
        deliveryUpdatedAt: new Date(),
        updatedAt: new Date(),
        ...(input.providerLogId !== undefined
          ? { providerLogId: input.providerLogId }
          : {}),
        ...(input.providerMessageId !== undefined
          ? { providerMessageId: input.providerMessageId }
          : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
        ...(input.deliveredAt !== undefined
          ? { deliveredAt: input.deliveredAt }
          : {}),
        ...(input.readAt !== undefined ? { readAt: input.readAt } : {}),
        ...(input.playedAt !== undefined ? { playedAt: input.playedAt } : {}),
        ...(input.status !== undefined
          ? {
              status: input.status,
              ...(input.status === "sent" ||
              input.status === "failed" ||
              input.status === "cancelled"
                ? { claimExpiresAt: null }
                : {}),
              ...(input.status === "sent" ? { lastError: null } : {}),
            }
          : {}),
      })
      .where(eq(messageOutbox.id, id))
      .returning();

    return record;
  }

  async cancelQueuedOutboxForConversation(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({
        status: "cancelled",
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          cancellablePreSendOutbox(),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /**
   * Cancels every still-retractable row except the exact terminal row that won
   * the Mongo lifecycle CAS.
   *
   * The caller holds the shared conversation advisory lock while committing
   * that CAS. Keeping the cancellation in the same lock interval gives a
   * completed conversation one outbound authority instead of leaving older
   * claimed replies to discover the close one by one in the dispatcher.
   * `authorizedOutboxId = null` means the terminal transition intentionally
   * has no closing copy, so every retractable row is cancelled.
   */
  async cancelQueuedOutboxForConversationExceptId(
    transaction: AppTransaction,
    conversationId: string,
    authorizedOutboxId: string | null,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({
        status: "cancelled",
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          ...(authorizedOutboxId === null
            ? []
            : [ne(messageOutbox.id, authorizedOutboxId)]),
          cancellablePreSendOutbox(),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /** Cancels one exact row only while transport entry is still impossible. */
  async cancelQueuedOutboxById(
    transaction: AppTransaction,
    id: string,
    lastError?: string,
  ): Promise<MessageOutboxRow | undefined> {
    const [cancelled] = await transaction
      .update(messageOutbox)
      .set({
        status: "cancelled",
        claimExpiresAt: null,
        ...(lastError !== undefined ? { lastError } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(messageOutbox.id, id), cancellablePreSendOutbox()))
      .returning();

    return cancelled;
  }

  /** Cancels bot-owned work on takeover while preserving queued staff sends. */
  async cancelQueuedAutomatedOutboxForConversation(
    transaction: AppTransaction,
    conversationId: string,
    authorizedOutboxId?: string | null,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({
        status: "cancelled",
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          sql`${messageOutbox.kind} <> 'staff'`,
          ...(authorizedOutboxId
            ? [ne(messageOutbox.id, authorizedOutboxId)]
            : []),
          cancellablePreSendOutbox(),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /**
   * Retracts automation made obsolete by a newly materialized participant turn.
   *
   * `system` and `staff` are explicit commitments, not questionnaire chatter.
   * The caller also supplies the exact Mongo-authorized terminal/handoff ids;
   * every other reply, intro or reminder is safe to retire only while it is
   * still before the provider-entry marker.
   */
  async cancelQueuedSupersededAutomationForConversation(
    transaction: AppTransaction,
    conversationId: string,
    preservedOutboxIds: readonly string[] = [],
  ): Promise<number> {
    const preserved = [
      ...new Set(preservedOutboxIds.map((id) => z.uuid().parse(id))),
    ];
    const cancelled = await transaction
      .update(messageOutbox)
      .set({
        status: "cancelled",
        claimExpiresAt: null,
        lastError: "superseded_by_newer_testimony",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          notInArray(messageOutbox.kind, ["system", "staff"]),
          ...(preserved.length > 0
            ? [notInArray(messageOutbox.id, preserved)]
            : []),
          cancellablePreSendOutbox(),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  async cancelQueuedOutboxForCampaign(
    transaction: AppTransaction,
    campaignId: string,
    preservedOutboxIds: readonly string[] = [],
  ): Promise<number> {
    const preserved = [
      ...new Set(preservedOutboxIds.map((id) => z.uuid().parse(id))),
    ];
    const cancelled = await transaction
      .update(messageOutbox)
      .set({
        status: "cancelled",
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageOutbox.campaignId, campaignId),
          ...(preserved.length > 0
            ? [notInArray(messageOutbox.id, preserved)]
            : []),
          cancellablePreSendOutbox(),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /**
   * The undelivered queue, oldest first, for the operator observability screen.
   *
   * Oldest first because age is the question the screen exists to answer, and
   * `message_outbox_status_created_idx` is `(status, created_at)`, so the order
   * is the index's own. One statement, no Redis and no per-row work: the
   * campaign and its event title come along on the join rather than through a
   * lookup the caller would repeat 200 times.
   */
  async listUndeliveredOutbox(
    limit = FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackUndeliveredOutboxRow[]> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
    );
    const rows = await executor
      .select({
        row: messageOutbox,
        campaignStatus: feedbackCampaigns.status,
        eventId: feedbackCampaigns.eventId,
        eventTitle: events.title,
      })
      .from(messageOutbox)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackCampaigns.id, messageOutbox.campaignId),
      )
      .innerJoin(events, eq(events.id, feedbackCampaigns.eventId))
      .where(
        inArray(messageOutbox.status, [
          ...FEEDBACK_OUTBOX_UNDELIVERED_STATUSES,
        ]),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(boundedLimit);

    return rows.map((entry) => ({
      row: entry.row,
      campaignStatus: entry.campaignStatus as FeedbackCampaignStatus,
      eventId: entry.eventId,
      eventTitle: entry.eventTitle,
    }));
  }

  /**
   * One page of the history, newest first, regardless of status.
   *
   * Delivered, failed and cancelled rows are exactly the ones the queue list
   * refuses to show, and the decision log makes them worth opening after the
   * fact. The filter narrows which rows exist for this page; the cursor says
   * where in that set the page begins.
   */
  async listRecentOutbox(
    options: {
      readonly limit?: number;
      readonly filter?: FeedbackOutboxHistoryFilter;
      readonly cursor?: FeedbackOutboxHistoryCursor | null;
    } = {},
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackUndeliveredOutboxRow[]> {
    const boundedLimit = Math.min(
      Math.max(1, options.limit ?? FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
      FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
    );
    const where = outboxHistoryWhere(
      options.filter ?? FEEDBACK_OUTBOX_HISTORY_NO_FILTER,
      options.cursor ?? null,
    );
    const rows = await executor
      .select({
        row: messageOutbox,
        campaignStatus: feedbackCampaigns.status,
        eventId: feedbackCampaigns.eventId,
        eventTitle: events.title,
      })
      .from(messageOutbox)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackCampaigns.id, messageOutbox.campaignId),
      )
      .innerJoin(events, eq(events.id, feedbackCampaigns.eventId))
      .where(where)
      // The exact order the cursor walks — any other order would hand back a
      // page the next cursor cannot continue from.
      .orderBy(desc(messageOutbox.createdAt), desc(messageOutbox.id))
      .limit(boundedLimit);

    return rows.map((entry) => ({
      row: entry.row,
      campaignStatus: entry.campaignStatus as FeedbackCampaignStatus,
      eventId: entry.eventId,
      eventTitle: entry.eventTitle,
    }));
  }

  /**
   * How many rows match the filter, so a page can say what it is a page *of*.
   *
   * Deliberately filter-aware and deliberately cursor-blind: «417 messages» must
   * mean «in the range you are looking at», or the number under a one-hour
   * filter would be a count of the whole table wearing the filter's clothes.
   */
  async countOutbox(
    filter: FeedbackOutboxHistoryFilter = FEEDBACK_OUTBOX_HISTORY_NO_FILTER,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ total: count() })
      .from(messageOutbox)
      .where(outboxHistoryWhere(filter, null));

    return row?.total ?? 0;
  }

  /**
   * Undelivered totals per status, so a capped list never implies the cap is
   * the whole backlog.
   */
  async countUndeliveredOutboxByStatus(
    executor: DatabaseExecutor = this.database.db,
  ): Promise<Map<FeedbackUndeliveredOutboxStatus, number>> {
    const rows = await executor
      .select({ status: messageOutbox.status, total: count() })
      .from(messageOutbox)
      .where(
        inArray(messageOutbox.status, [
          ...FEEDBACK_OUTBOX_UNDELIVERED_STATUSES,
        ]),
      )
      .groupBy(messageOutbox.status);

    const totals = new Map<FeedbackUndeliveredOutboxStatus, number>(
      FEEDBACK_OUTBOX_UNDELIVERED_STATUSES.map((status) => [status, 0]),
    );
    for (const row of rows) {
      const status = FEEDBACK_OUTBOX_UNDELIVERED_STATUSES.find(
        (candidate) => candidate === row.status,
      );
      if (status) {
        totals.set(status, Number(row.total));
      }
    }
    return totals;
  }

  /**
   * Claims due rows directly for a dispatcher replica.
   *
   * The campaign join keeps paused/closed rows out of the candidate limit and
   * `FOR UPDATE OF message_outbox SKIP LOCKED` lets replicas walk one backlog
   * without either double-claiming a row or serializing on the campaign row.
   * Only a `claimed` row with no send marker may be reclaimed after expiry.
   */
  async listTerminalDispatchCandidates(
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
  ): Promise<FeedbackOutboxTerminalCandidate[]> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      FEEDBACK_OUTBOX_BATCH_SIZE,
    );
    const olderOutbox = alias(messageOutbox, "older_terminal_outbox");

    const rows = await this.database.db
      .select({
        conversationId: messageOutbox.conversationId,
        outboxId: messageOutbox.id,
      })
      .from(messageOutbox)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackCampaigns.id, messageOutbox.campaignId),
      )
      .where(
        and(
          // This is only a bounded discovery hint. MongoDB grants authority by
          // exact lifecycle id before the claim query receives any exception.
          eq(messageOutbox.kind, "system"),
          sql`${messageOutbox.dedupeKey} = 'feedback-stop-ack-' || ${messageOutbox.conversationId}::text`,
          or(
            eq(messageOutbox.status, "pending"),
            and(
              eq(messageOutbox.status, "claimed"),
              lte(messageOutbox.claimExpiresAt, sql`clock_timestamp()`),
              isNull(messageOutbox.sendStartedAt),
            ),
          ),
          or(
            ne(feedbackCampaigns.status, "launched"),
            exists(
              this.database.db
                .select({ id: olderOutbox.id })
                .from(olderOutbox)
                .where(
                  and(
                    eq(
                      olderOutbox.conversationId,
                      messageOutbox.conversationId,
                    ),
                    eq(olderOutbox.status, "ambiguous"),
                    or(
                      lt(olderOutbox.createdAt, messageOutbox.createdAt),
                      and(
                        eq(olderOutbox.createdAt, messageOutbox.createdAt),
                        lt(olderOutbox.id, messageOutbox.id),
                      ),
                    ),
                  ),
                ),
            ),
          ),
          notExists(
            this.database.db
              .select({ id: olderOutbox.id })
              .from(olderOutbox)
              .where(
                and(
                  eq(olderOutbox.conversationId, messageOutbox.conversationId),
                  inArray(
                    olderOutbox.status,
                    FEEDBACK_OUTBOX_FIFO_LIVE_BLOCKING_STATUSES,
                  ),
                  or(
                    lt(olderOutbox.createdAt, messageOutbox.createdAt),
                    and(
                      eq(olderOutbox.createdAt, messageOutbox.createdAt),
                      lt(olderOutbox.id, messageOutbox.id),
                    ),
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(boundedLimit);

    return rows;
  }

  async claimDispatchBatch(
    _now: Date,
    limit = FEEDBACK_OUTBOX_DISPATCH_BATCH_SIZE,
    leaseMs = FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
    terminalOutboxIds: readonly string[] = [],
  ): Promise<FeedbackOutboxClaimedRow[]> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      FEEDBACK_OUTBOX_BATCH_SIZE,
    );
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Feedback outbox dispatch lease must be positive");
    }
    const authorizedTerminalIds = [
      ...new Set(terminalOutboxIds.map((id) => z.uuid().parse(id))),
    ];

    const claimToken = randomUUID();
    const claimExpiresAt = sql<Date>`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`;
    const olderOutbox = alias(messageOutbox, "older_message_outbox");

    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ row: messageOutbox })
        .from(messageOutbox)
        .innerJoin(
          feedbackCampaigns,
          eq(feedbackCampaigns.id, messageOutbox.campaignId),
        )
        .where(
          and(
            authorizedTerminalIds.length > 0
              ? or(
                  eq(feedbackCampaigns.status, "launched"),
                  inArray(messageOutbox.id, authorizedTerminalIds),
                )
              : eq(feedbackCampaigns.status, "launched"),
            or(
              eq(messageOutbox.status, "pending"),
              and(
                eq(messageOutbox.status, "claimed"),
                lte(messageOutbox.claimExpiresAt, sql`clock_timestamp()`),
                isNull(messageOutbox.sendStartedAt),
              ),
            ),
            // Only the oldest unresolved row of a conversation may be claimed.
            // The correlated read still sees an older row when another replica
            // has it locked, so `SKIP LOCKED` cannot leapfrog that row.
            notExists(
              transaction
                .select({ id: olderOutbox.id })
                .from(olderOutbox)
                .where(
                  and(
                    eq(
                      olderOutbox.conversationId,
                      messageOutbox.conversationId,
                    ),
                    inArray(
                      olderOutbox.status,
                      FEEDBACK_OUTBOX_FIFO_BLOCKING_STATUSES,
                    ),
                    // Human takeover and the exact terminal lifecycle winner
                    // must not deadlock behind an uncertainty with no automatic
                    // resolution path. Neither may pass a live/pre-send row.
                    or(
                      ne(olderOutbox.status, "ambiguous"),
                      and(
                        ne(messageOutbox.kind, "staff"),
                        ...(authorizedTerminalIds.length > 0
                          ? [
                              notInArray(
                                messageOutbox.id,
                                authorizedTerminalIds,
                              ),
                            ]
                          : []),
                      ),
                    ),
                    or(
                      lt(olderOutbox.createdAt, messageOutbox.createdAt),
                      and(
                        eq(olderOutbox.createdAt, messageOutbox.createdAt),
                        lt(olderOutbox.id, messageOutbox.id),
                      ),
                    ),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
        .limit(boundedLimit)
        .for("update", { of: messageOutbox, skipLocked: true });

      if (candidates.length === 0) {
        return [];
      }

      const candidateIds = candidates.map(({ row }) => row.id);
      const claimed = await transaction
        .update(messageOutbox)
        .set({
          status: "claimed",
          claimToken,
          claimExpiresAt,
          sendStartedAt: null,
          lastError: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(inArray(messageOutbox.id, candidateIds))
        .returning();
      const byId = new Map(claimed.map((row) => [row.id, row]));

      return candidateIds.flatMap((id) => {
        const row = byId.get(id);
        if (
          !row ||
          row.status !== "claimed" ||
          !row.claimToken ||
          !row.claimExpiresAt ||
          row.sendStartedAt !== null
        ) {
          return [];
        }
        return [row as FeedbackOutboxClaimedRow];
      });
    });
  }

  /**
   * Releases only the live pre-send claim owned by `claimToken`.
   *
   * Redis/pacing, transcript and state-check failures happen before the send
   * marker, so this transition is safe to retry. A stale owner cannot release
   * a claim that another replica has already reclaimed.
   */
  async releaseDispatchClaim(
    id: string,
    claimToken: string,
    now: Date,
    lastError?: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .update(messageOutbox)
      .set({
        status: "pending",
        claimToken: null,
        claimExpiresAt: null,
        lastError: lastError ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "claimed"),
          eq(messageOutbox.claimToken, claimToken),
          isNull(messageOutbox.sendStartedAt),
        ),
      )
      .returning();

    return record;
  }

  /**
   * Renews one exact pre-send token after deployment-wide pacing.
   *
   * The old expiry is deliberately not a predicate: a long global wait may
   * outlive the initial lease. The opaque token is the fence. If another
   * replica reclaimed first its token changed and this update loses; if this
   * update locks first, a waiting `SKIP LOCKED` claimant re-evaluates the now
   * live lease and leaves the row alone.
   */
  async renewDispatchClaim(
    id: string,
    claimToken: string,
    _now: Date,
    leaseMs = FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
  ): Promise<MessageOutboxRow | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Feedback outbox dispatch lease must be positive");
    }
    const [record] = await this.database.db
      .update(messageOutbox)
      .set({
        claimExpiresAt: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "claimed"),
          eq(messageOutbox.claimToken, claimToken),
          isNull(messageOutbox.sendStartedAt),
        ),
      )
      .returning();

    return record;
  }

  /**
   * The durable no-return boundary immediately before the provider call.
   * Anything after this CAS may have reached the provider and must never fall
   * back to `pending` merely because the worker disappeared. Campaign state
   * must still be `launched`, except when the final MongoDB guard passes the
   * exact STOP acknowledgement id being marked; a mismatched id grants no
   * capability.
   */
  async markDispatchAttemptStarted(
    id: string,
    claimToken: string,
    _now: Date,
    leaseMs = FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
    authorizedStopOutboxId: string | null = null,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Feedback outbox dispatch lease must be positive");
    }
    const stopAuthorization = z.uuid().nullable().parse(authorizedStopOutboxId);
    const exactStopAuthorization = stopAuthorization === id ? id : null;
    const [record] = await executor
      .update(messageOutbox)
      .set({
        status: "attempting",
        sendStartedAt: sql`clock_timestamp()`,
        claimExpiresAt: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
        attemptCount: sql`${messageOutbox.attemptCount} + 1`,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "claimed"),
          eq(messageOutbox.claimToken, claimToken),
          gt(messageOutbox.claimExpiresAt, sql`clock_timestamp()`),
          isNull(messageOutbox.sendStartedAt),
          exists(
            this.database.db
              .select({ id: feedbackCampaigns.id })
              .from(feedbackCampaigns)
              .where(
                and(
                  eq(feedbackCampaigns.id, messageOutbox.campaignId),
                  exactStopAuthorization
                    ? or(
                        eq(feedbackCampaigns.status, "launched"),
                        eq(messageOutbox.id, exactStopAuthorization),
                      )
                    : eq(feedbackCampaigns.status, "launched"),
                ),
              )
              .for("share"),
          ),
        ),
      )
      .returning();

    return record;
  }

  /** Marks a pre-send claim terminal without allowing a stale owner to win. */
  async finishDispatchClaimBeforeAttempt(
    id: string,
    claimToken: string,
    status: "failed" | "cancelled",
    now: Date,
    lastError: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .update(messageOutbox)
      .set({
        status,
        claimExpiresAt: null,
        lastError,
        ...(status === "failed"
          ? { deliveryStatus: "error", deliveryUpdatedAt: now }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "claimed"),
          eq(messageOutbox.claimToken, claimToken),
          isNull(messageOutbox.sendStartedAt),
        ),
      )
      .returning();

    return record;
  }

  async markDispatchSent(
    id: string,
    claimToken: string,
    input: {
      readonly completedAt: Date;
      readonly providerLogId: string;
      readonly providerMessageId?: string;
      readonly deliveryStatus: Exclude<MessageOutboxDeliveryStatus, "error">;
      readonly sentAt?: Date | null;
      readonly deliveredAt?: Date | null;
      readonly readAt?: Date | null;
      readonly playedAt?: Date | null;
    },
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await this.database.db
      .update(messageOutbox)
      .set({
        status: "sent",
        claimExpiresAt: null,
        providerLogId: input.providerLogId,
        ...(input.providerMessageId
          ? { providerMessageId: input.providerMessageId }
          : {}),
        deliveryStatus: input.deliveryStatus,
        deliveryUpdatedAt: input.completedAt,
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
        ...(input.deliveredAt !== undefined
          ? { deliveredAt: input.deliveredAt }
          : {}),
        ...(input.readAt !== undefined ? { readAt: input.readAt } : {}),
        ...(input.playedAt !== undefined ? { playedAt: input.playedAt } : {}),
        lastError: null,
        updatedAt: input.completedAt,
      })
      .where(activeDispatchAttempt(id, claimToken))
      .returning();

    return record;
  }

  async markDispatchFailed(
    id: string,
    claimToken: string,
    now: Date,
    lastError: string,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await this.database.db
      .update(messageOutbox)
      .set({
        status: "failed",
        claimExpiresAt: null,
        deliveryStatus: "error",
        deliveryUpdatedAt: now,
        lastError,
        updatedAt: now,
      })
      .where(activeDispatchAttempt(id, claimToken))
      .returning();

    return record;
  }

  async markDispatchAmbiguous(
    id: string,
    claimToken: string,
    now: Date,
    lastError: string,
    providerLogId?: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .update(messageOutbox)
      .set({
        status: "ambiguous",
        claimExpiresAt: null,
        deliveryStatus: "pending",
        deliveryUpdatedAt: now,
        ...(providerLogId ? { providerLogId } : {}),
        lastError,
        updatedAt: now,
      })
      .where(activeDispatchAttempt(id, claimToken))
      .returning();

    return record;
  }

  /** Finds bounded post-marker attempts whose PostgreSQL lease has expired. */
  async findExpiredDispatchAttempts(
    _now: Date,
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
  ): Promise<MessageOutboxRow[]> {
    return this.database.db
      .select()
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.status, "attempting"),
          lte(messageOutbox.claimExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(Math.min(Math.max(1, limit), FEEDBACK_OUTBOX_BATCH_SIZE));
  }

  /**
   * Quarantines one expired post-marker attempt after its conversation has been
   * parked for human review. The token and database-clock expiry are repeated
   * in the CAS so a provider observation or live renewal wins cleanly.
   */
  async quarantineExpiredDispatchAttempt(
    id: string,
    claimToken: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .update(messageOutbox)
      .set({
        status: "ambiguous",
        claimExpiresAt: null,
        deliveryStatus: "pending",
        deliveryUpdatedAt: sql`clock_timestamp()`,
        lastError: "dispatch_lease_expired_after_send_start",
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "attempting"),
          eq(messageOutbox.claimToken, claimToken),
          lte(messageOutbox.claimExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();

    return record;
  }

  /**
   * Retires stale rows owned by the legacy relay/deliver path.
   *
   * `sending` proves only that the relay handed the row to BullMQ; it cannot
   * prove whether the old consumer entered the provider call. Releasing one to
   * `pending` could duplicate a WhatsApp message, while inventing a send marker
   * would turn uncertainty into fake evidence. The explicit legacy ambiguous
   * shape therefore records no token, start time or attempt count and is never
   * selected by the direct dispatcher.
   */
  async findStaleLegacySending(
    _now: Date,
    recoveryMs = FEEDBACK_OUTBOX_RECOVERY_MS,
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
  ): Promise<MessageOutboxRow[]> {
    if (!Number.isInteger(recoveryMs) || recoveryMs < 1) {
      throw new Error("Feedback outbox recovery horizon must be positive");
    }
    return this.database.db
      .select()
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.status, "sending"),
          lte(
            messageOutbox.updatedAt,
            sql`clock_timestamp() - (${recoveryMs} * interval '1 millisecond')`,
          ),
        ),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(Math.min(Math.max(1, limit), FEEDBACK_OUTBOX_BATCH_SIZE));
  }

  /** Quarantines one still-stale V1 row after its conversation is parked. */
  async quarantineStaleLegacySending(
    id: string,
    recoveryMs = FEEDBACK_OUTBOX_RECOVERY_MS,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    if (!Number.isInteger(recoveryMs) || recoveryMs < 1) {
      throw new Error("Feedback outbox recovery horizon must be positive");
    }
    const [record] = await executor
      .update(messageOutbox)
      .set({
        status: "ambiguous",
        claimToken: null,
        claimExpiresAt: null,
        sendStartedAt: null,
        attemptCount: 0,
        deliveryStatus: sql`coalesce(${messageOutbox.deliveryStatus}, 'pending')`,
        deliveryUpdatedAt: sql`coalesce(${messageOutbox.deliveryUpdatedAt}, clock_timestamp())`,
        lastError: FEEDBACK_OUTBOX_LEGACY_AMBIGUOUS_ERROR,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "sending"),
          lte(
            messageOutbox.updatedAt,
            sql`clock_timestamp() - (${recoveryMs} * interval '1 millisecond')`,
          ),
        ),
      )
      .returning();

    return record;
  }
}

function activeDispatchAttempt(id: string, claimToken: string): SQL {
  return and(
    eq(messageOutbox.id, id),
    eq(messageOutbox.status, "attempting"),
    eq(messageOutbox.claimToken, claimToken),
    gt(messageOutbox.claimExpiresAt, sql`clock_timestamp()`),
  ) as SQL;
}

/**
 * Rows that provably have not entered transport.
 *
 * A `claimed` row carries an owner token, but cancellation wins by changing its
 * status under the row lock before `claimed -> attempting`; the old owner then
 * loses its token-and-status CAS. `attempting` and legacy `sending` are excluded
 * because provider entry may already have happened.
 */
function cancellablePreSendOutbox(): SQL {
  return or(
    inArray(messageOutbox.status, ["pending", "held"]),
    and(
      eq(messageOutbox.status, "claimed"),
      isNull(messageOutbox.sendStartedAt),
    ),
  ) as SQL;
}

/**
 * The one predicate the history page and its total are both cut from.
 *
 * They must be the same clause or the count is a claim about a different set of
 * rows than the page beside it — which is how «showing 25 of 4,912» ends up
 * printed above twelve rows. The cursor is the only part the count leaves out.
 *
 * The keyset is written as `created_at < c` OR (`created_at = c` AND `id < c`)
 * rather than a row-value comparison so it is built from typed Drizzle
 * operators: same rows, no hand-written cast, and the whole thing stays
 * assertable without a database.
 */
function outboxHistoryWhere(
  filter: FeedbackOutboxHistoryFilter,
  cursor: FeedbackOutboxHistoryCursor | null,
): SQL | undefined {
  const clauses: SQL[] = [];

  if (filter.status !== null) {
    clauses.push(eq(messageOutbox.status, filter.status));
  }
  if (filter.from !== null) {
    clauses.push(gte(messageOutbox.createdAt, filter.from));
  }
  if (filter.to !== null) {
    clauses.push(lte(messageOutbox.createdAt, filter.to));
  }
  if (cursor !== null) {
    clauses.push(
      or(
        lt(messageOutbox.createdAt, cursor.createdAt),
        and(
          eq(messageOutbox.createdAt, cursor.createdAt),
          lt(messageOutbox.id, cursor.id),
        ),
      ) as SQL,
    );
  }

  return clauses.length === 0 ? undefined : and(...clauses);
}
