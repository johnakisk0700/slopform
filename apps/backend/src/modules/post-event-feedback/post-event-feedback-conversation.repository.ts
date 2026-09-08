import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  feedbackCampaigns,
  feedbackConversationExecutions,
  feedbackConversations,
  type AppTransaction,
  type FeedbackConversationRow,
  type FeedbackConversationStoredMessage,
} from "@slopform/database";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import {
  postEventFeedbackAttentionReasonSchema,
  type PostEventFeedbackAttentionReason,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "./attention.js";
import {
  assertMessageIdentity,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  FEEDBACK_CONVERSATION_CHANNEL,
  FEEDBACK_CONVERSATION_LIFECYCLE_REASONS,
  FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
  FEEDBACK_CONVERSATION_PURPOSE,
  FEEDBACK_CONVERSATION_SCHEMA_VERSION,
  messageIdentityKeys,
  resolveFeedbackConversationWork,
  type AppendFeedbackConversationMessageInput,
  type FeedbackConversationControlSource,
  type FeedbackConversationDocument,
  type FeedbackConversationGoal,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationMessage,
  type FeedbackConversationRespondent,
  type FeedbackConversationSummary,
} from "./post-event-feedback-conversation.document.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationTransitionError,
} from "./post-event-feedback-conversation.errors.js";
import {
  conversationMessagesExceedCapacity,
  serializeConversationJson,
  toDocument,
  toLaunchInsert,
  toRespondent,
  toRowUpdate,
  toSummary,
  type FeedbackConversationDerived,
} from "./post-event-feedback-conversation.persistence.js";
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
import type {
  FeedbackCampaignAttentionEvidence,
  FeedbackCampaignLifecycleStats,
  FeedbackConversationAdvanceCursorInput,
  FeedbackConversationAppendResult,
  FeedbackConversationAwaitHumanCursorInput,
  FeedbackConversationCloseCursorInput,
  FeedbackConversationCreationResult,
  FeedbackConversationExtractionAccounting,
  FeedbackConversationLaunchInput,
  FeedbackConversationOverviewStats,
  FeedbackConversationWorkCursor,
  FeedbackConversationWorkTransitionResult,
  FeedbackTerminalOutboxCandidate,
} from "./post-event-feedback-conversation.types.js";

export {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationTransitionError,
  type FeedbackConversationTransitionResult,
};

const FEEDBACK_SUMMARY_ATTENTION_EVIDENCE_LIMIT = 40;
const FEEDBACK_SUMMARY_MESSAGE_EXCERPT_MAX = 180;

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

/**
 * Owns every campaign conversation row. Schema-v1 assistant documents stay
 * in MongoDB and are never read or rewritten here.
 */
@Injectable()
export class FeedbackConversationRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Creates the conversation for one launched campaign recipient. The
   * deterministic id makes launch replay idempotent, and a conversation
   * already closed by STOP is returned as-is instead of being recreated.
   */
  async createFromLaunch(
    transaction: AppTransaction,
    input: FeedbackConversationLaunchInput,
  ): Promise<FeedbackConversationCreationResult> {
    const document: FeedbackConversationDocument = {
      _id: deriveFeedbackConversationId(
        input.campaignId,
        input.respondentParticipantId,
      ),
      schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
      purpose: FEEDBACK_CONVERSATION_PURPOSE,
      channel: FEEDBACK_CONVERSATION_CHANNEL,
      campaignId: input.campaignId,
      respondentParticipantId: input.respondentParticipantId,
      phoneAtLaunch: input.phoneAtLaunch,
      lifecycle: { state: "open", reason: null, closedAt: null },
      control: { mode: "bot", source: "launch", changedAt: input.launchedAt },
      goals: input.goals ? [...input.goals] : buildFeedbackConversationGoals(),
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
      work: { revision: 0, nextActionAt: null, executionEpoch: 0 },
      needsAttention: false,
      attentionReasons: [],
      remindedAt: null,
      reminderCount: 0,
      awaitingHuman: false,
      hostileTurns: 0,
      extractionFallbackAckSent: false,
      createdAt: input.launchedAt,
      updatedAt: input.launchedAt,
    };

    const [inserted] = await transaction
      .insert(feedbackConversations)
      .values(toLaunchInsert(document))
      .onConflictDoNothing()
      .returning({ id: feedbackConversations.id });
    if (!inserted) {
      const existing = await this.findById(document._id, transaction);
      if (!existing) {
        throw new FeedbackConversationPhoneConflictError();
      }
      if (
        existing.campaignId !== document.campaignId ||
        existing.respondentParticipantId !== document.respondentParticipantId
      ) {
        throw new ConversationPersistenceError(
          "Feedback conversation id belongs to a different campaign or respondent",
        );
      }
      return { created: false, conversation: existing };
    }

    const derived = await this.loadDerived(transaction, {
      id: document._id,
      campaignId: document.campaignId,
    });
    return {
      created: true,
      conversation: toDocumentFromLaunch(document, derived),
    };
  }

  async findById(
    id: string,
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument | undefined> {
    return this.selectDocument(this.executor(transaction), id);
  }

  async findByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    return this.loadForUpdate(transaction, id).then(
      (loaded) => loaded?.conversation,
    );
  }

  /**
   * Resolves a bounded PostgreSQL candidate set to the exact terminal outbox
   * ids currently authorized by the conversation row.
   *
   * The pair check after the projected `IN` query matters: two candidate
   * conversations must not be able to authorize one another's row merely
   * because both ids occur somewhere in the batch.
   */
  async listCurrentTerminalOutboxIds(
    candidates: readonly FeedbackTerminalOutboxCandidate[],
    transaction?: AppTransaction,
  ): Promise<string[]> {
    if (candidates.length === 0) return [];

    const outboxIdsByConversation = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const existing = outboxIdsByConversation.get(candidate.conversationId);
      if (existing) {
        existing.add(candidate.outboxId);
      } else {
        outboxIdsByConversation.set(
          candidate.conversationId,
          new Set([candidate.outboxId]),
        );
      }
    }

    const rows = await this.executor(transaction)
      .select({
        id: feedbackConversations.id,
        terminalOutboxId: feedbackConversations.terminalOutboxId,
      })
      .from(feedbackConversations)
      .where(
        and(
          inArray(feedbackConversations.id, [
            ...outboxIdsByConversation.keys(),
          ]),
          eq(feedbackConversations.lifecycleState, "closed"),
          inArray(feedbackConversations.terminalOutboxId, [
            ...new Set(candidates.map((candidate) => candidate.outboxId)),
          ]),
        ),
      );

    return rows.flatMap((row) => {
      if (row.terminalOutboxId === null) {
        return [];
      }
      return outboxIdsByConversation.get(row.id)?.has(row.terminalOutboxId)
        ? [row.terminalOutboxId]
        : [];
    });
  }

  /** Exact STOP acknowledgements a campaign close must leave retractable. */
  async listStopTerminalOutboxIdsForCampaign(
    campaignId: string,
    transaction?: AppTransaction,
  ): Promise<string[]> {
    const rows = await this.executor(transaction)
      .select({
        terminalOutboxId: feedbackConversations.terminalOutboxId,
      })
      .from(feedbackConversations)
      .where(
        and(
          eq(feedbackConversations.campaignId, campaignId),
          eq(feedbackConversations.lifecycleState, "closed"),
          eq(feedbackConversations.lifecycleReason, "stopped"),
          isNotNull(feedbackConversations.terminalOutboxId),
        ),
      );
    return rows.flatMap((row) =>
      row.terminalOutboxId ? [row.terminalOutboxId] : [],
    );
  }

  /**
   * Resolves inbound traffic to its conversation (D9). The partial unique
   * index guarantees at most one open feedback conversation per phone number.
   */
  async findOpenByPhone(
    phoneAtLaunch: string,
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument | undefined> {
    return this.selectDocumentBy(
      this.executor(transaction),
      and(
        eq(feedbackConversations.lifecycleState, "open"),
        eq(feedbackConversations.phoneAtLaunch, phoneAtLaunch),
      ),
    );
  }

  /**
   * The most recently closed conversation on a number, for traffic that arrives
   * after the questionnaire ended.
   */
  async findLatestClosedByPhone(
    phoneAtLaunch: string,
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument | undefined> {
    const [row] = await this.executor(transaction)
      .select({
        conversation: feedbackConversations,
        executionEpoch: feedbackConversationExecutions.epoch,
        campaignResumeGeneration: feedbackCampaigns.resumeGeneration,
      })
      .from(feedbackConversations)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackConversations.campaignId, feedbackCampaigns.id),
      )
      .leftJoin(
        feedbackConversationExecutions,
        eq(
          feedbackConversations.id,
          feedbackConversationExecutions.conversationId,
        ),
      )
      .where(
        and(
          eq(feedbackConversations.lifecycleState, "closed"),
          eq(feedbackConversations.phoneAtLaunch, phoneAtLaunch),
        ),
      )
      .orderBy(desc(feedbackConversations.updatedAt))
      .limit(1);
    return row ? toDocument(row.conversation, derivedFromJoin(row)) : undefined;
  }

  /**
   * Who a batch of conversations is with, and nothing else.
   */
  async listRespondentsByIds(
    conversationIds: readonly string[],
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationRespondent[]> {
    const unique = [...new Set(conversationIds)];
    if (unique.length === 0) {
      return [];
    }
    const rows = await this.executor(transaction)
      .select({
        id: feedbackConversations.id,
        respondentParticipantId: feedbackConversations.respondentParticipantId,
        phoneAtLaunch: feedbackConversations.phoneAtLaunch,
      })
      .from(feedbackConversations)
      .where(inArray(feedbackConversations.id, unique));
    return rows.map((row) => toRespondent(row));
  }

  /**
   * One batched, projection-only read for rehearsal token accounting.
   */
  async listExtractionAccountingForCampaigns(
    campaignIds: readonly string[],
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationExtractionAccounting[]> {
    const unique = [...new Set(campaignIds)];
    if (unique.length === 0) {
      return [];
    }
    const rows = await this.executor(transaction)
      .select({
        id: feedbackConversations.id,
        extractionModel: feedbackConversations.extractionModel,
        extractionUsage: feedbackConversations.extractionUsage,
        extractionServiceTier: feedbackConversations.extractionServiceTier,
      })
      .from(feedbackConversations)
      .where(inArray(feedbackConversations.campaignId, unique));
    return rows.map((row) => ({
      conversationId: row.id,
      extraction: {
        model: row.extractionModel ?? null,
        usage: row.extractionUsage ?? null,
        serviceTier: row.extractionServiceTier ?? null,
      },
    }));
  }

  /**
   * Compact campaign-grouped list read. Transcripts stay out of list
   * responses; only counts and last-message metadata are projected.
   */
  async listForCampaign(
    campaignId: string,
    limit = 100,
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationSummary[]> {
    const rows = await this.executor(transaction)
      .select({
        id: feedbackConversations.id,
        campaignId: feedbackConversations.campaignId,
        respondentParticipantId: feedbackConversations.respondentParticipantId,
        phoneAtLaunch: feedbackConversations.phoneAtLaunch,
        lifecycleState: feedbackConversations.lifecycleState,
        lifecycleReason: feedbackConversations.lifecycleReason,
        controlMode: feedbackConversations.controlMode,
        controlSource: feedbackConversations.controlSource,
        goals: feedbackConversations.goals,
        messageCount: sql<number>`jsonb_array_length(${feedbackConversations.messages})`,
        lastMessageAt: sql<
          string | null
        >`${feedbackConversations.messages} -> -1 ->> 'at'`,
        lastMessageActor: sql<
          FeedbackConversationMessage["actor"] | null
        >`${feedbackConversations.messages} -> -1 ->> 'actor'`,
        cursorSeq: feedbackConversations.cursorSeq,
        needsAttention: feedbackConversations.needsAttention,
        extractionParked: sql<boolean>`${feedbackConversations.parkedSince} is not null`,
        remindedAt: feedbackConversations.remindedAt,
        createdAt: feedbackConversations.createdAt,
        updatedAt: feedbackConversations.updatedAt,
      })
      .from(feedbackConversations)
      .where(eq(feedbackConversations.campaignId, campaignId))
      .orderBy(desc(feedbackConversations.updatedAt))
      .limit(limit);
    return rows.map((row) =>
      toSummary({
        row,
        messageCount: Number(row.messageCount),
        lastMessageAt: row.lastMessageAt,
        lastMessageActor: row.lastMessageActor,
        extractionParked: Boolean(row.extractionParked),
      }),
    );
  }

  /**
   * Unresolved attention rows for the campaign summary prompt: kind plus a
   * short cited-message excerpt. Only conversations that still need a person
   * are loaded, so a finished quiet campaign pays almost nothing.
   */
  async listAttentionEvidenceForCampaign(
    campaignId: string,
    transaction?: AppTransaction,
  ): Promise<FeedbackCampaignAttentionEvidence[]> {
    const rows = await this.executor(transaction)
      .select({
        id: feedbackConversations.id,
        respondentParticipantId: feedbackConversations.respondentParticipantId,
        attentionReasons: feedbackConversations.attentionReasons,
        messages: feedbackConversations.messages,
      })
      .from(feedbackConversations)
      .where(
        and(
          eq(feedbackConversations.campaignId, campaignId),
          eq(feedbackConversations.needsAttention, true),
        ),
      )
      .limit(FEEDBACK_SUMMARY_ATTENTION_EVIDENCE_LIMIT);

    const evidence: FeedbackCampaignAttentionEvidence[] = [];
    for (const row of rows) {
      const messagesById = new Map(
        (row.messages ?? []).map((message) => [message.id, message.text]),
      );
      for (const reason of row.attentionReasons ?? []) {
        if (reason.resolvedAt != null) {
          continue;
        }
        const kind = postEventFeedbackAttentionReasonSchema.safeParse(
          reason.kind,
        );
        if (!kind.success) {
          continue;
        }
        const text =
          reason.messageId === null
            ? null
            : (messagesById.get(reason.messageId) ?? null);
        evidence.push({
          conversationId: row.id,
          respondentParticipantId: row.respondentParticipantId,
          kind: kind.data,
          messageExcerpt: excerptForSummary(text),
        });
        if (evidence.length >= FEEDBACK_SUMMARY_ATTENTION_EVIDENCE_LIMIT) {
          return evidence;
        }
      }
    }
    return evidence;
  }

  /** Open conversations still accepting feedback in one campaign. */
  async countOpenForCampaign(
    campaignId: string,
    transaction?: AppTransaction,
  ): Promise<number> {
    const [row] = await this.executor(transaction)
      .select({ value: count() })
      .from(feedbackConversations)
      .where(
        and(
          eq(feedbackConversations.campaignId, campaignId),
          eq(feedbackConversations.lifecycleState, "open"),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /**
   * Exact platform-wide conversation counters for the admin Overview.
   */
  async aggregateOverviewStats(
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationOverviewStats> {
    const executor = this.executor(transaction);
    const [facet] = await executor
      .select({
        total: sql<number>`cast(count(*) as integer)`,
        open: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleState} = 'open') as integer)`,
        closed: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleState} = 'closed') as integer)`,
        completed: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleReason} = 'completed') as integer)`,
        declined: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleReason} = 'declined') as integer)`,
        stopped: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleReason} = 'stopped') as integer)`,
        expired: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleReason} = 'expired') as integer)`,
        cancelled: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleReason} = 'cancelled') as integer)`,
        needsAttention: sql<number>`cast(count(*) filter (where ${feedbackConversations.needsAttention}) as integer)`,
        extractionParked: sql<number>`cast(count(*) filter (where ${feedbackConversations.parkedSince} is not null) as integer)`,
      })
      .from(feedbackConversations);

    const reasonResult = await executor.execute<{
      kind: string;
      count: number;
    }>(sql`
      select reason ->> 'kind' as kind, count(*)::int as count
      from ${feedbackConversations},
      lateral jsonb_array_elements(${feedbackConversations.attentionReasons}) as reason
      where ${feedbackConversations.needsAttention} = true
        and (reason ->> 'resolvedAt') is null
      group by 1
      order by 2 desc, 1 asc
    `);

    const byClosedReason: Record<FeedbackConversationLifecycleReason, number> =
      {
        completed: asCount(facet?.completed),
        declined: asCount(facet?.declined),
        stopped: asCount(facet?.stopped),
        expired: asCount(facet?.expired),
        cancelled: asCount(facet?.cancelled),
      };
    for (const reason of FEEDBACK_CONVERSATION_LIFECYCLE_REASONS) {
      byClosedReason[reason] = byClosedReason[reason] ?? 0;
    }

    const attentionByReason = (reasonResult.rows ?? [])
      .map((row) => {
        const reason = postEventFeedbackAttentionReasonSchema.safeParse(
          row.kind,
        );
        const value = z.number().int().positive().safeParse(Number(row.count));
        if (!reason.success || !value.success) {
          return null;
        }
        return { reason: reason.data, count: value.data };
      })
      .filter(
        (
          entry,
        ): entry is {
          reason: PostEventFeedbackAttentionReason;
          count: number;
        } => entry !== null,
      );

    return {
      total: asCount(facet?.total),
      open: asCount(facet?.open),
      closed: asCount(facet?.closed),
      byClosedReason,
      needsAttention: asCount(facet?.needsAttention),
      extractionParked: asCount(facet?.extractionParked),
      attentionByReason,
    };
  }

  async listLifecycleStatsForCampaigns(
    campaignIds: readonly string[],
    transaction?: AppTransaction,
  ): Promise<FeedbackCampaignLifecycleStats[]> {
    const ids = [...new Set(campaignIds)];
    if (ids.length === 0) return [];

    const rows = await this.executor(transaction)
      .select({
        campaignId: feedbackConversations.campaignId,
        totalCount: count(),
        openCount: sql<number>`cast(count(*) filter (where ${feedbackConversations.lifecycleState} = 'open') as integer)`,
        latestClosedAt: max(feedbackConversations.closedAt),
      })
      .from(feedbackConversations)
      .where(inArray(feedbackConversations.campaignId, ids))
      .groupBy(feedbackConversations.campaignId);

    return rows.map((row) => ({
      campaignId: row.campaignId,
      totalCount: Number(row.totalCount),
      openCount: Number(row.openCount),
      latestClosedAt: row.latestClosedAt ?? null,
    }));
  }

  /**
   * Oldest durable reconciliation intents first.
   *
   * Closed conversations are intentionally included. A close racing an already
   * scheduled revision must get one cheap planner pass that settles the intent
   * to null; filtering it here would leave a permanent due row in the index.
   */
  async listDueWork(
    input: {
      readonly dueAt: Date;
      readonly limit?: number;
      readonly campaignId?: string;
      readonly after?: FeedbackConversationWorkCursor;
    },
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationDocument[]> {
    const limit = input.limit ?? 50;
    const { after } = input;
    const dueWindow = after
      ? or(
          and(
            gt(feedbackConversations.workNextActionAt, after.nextActionAt),
            lte(feedbackConversations.workNextActionAt, input.dueAt),
          ),
          and(
            eq(feedbackConversations.workNextActionAt, after.nextActionAt),
            gt(feedbackConversations.id, after.conversationId),
          ),
        )
      : lte(feedbackConversations.workNextActionAt, input.dueAt);
    const filters = [
      isNotNull(feedbackConversations.workNextActionAt),
      dueWindow,
    ];
    if (input.campaignId) {
      filters.push(eq(feedbackConversations.campaignId, input.campaignId));
    }
    const rows = await this.executor(transaction)
      .select({
        conversation: feedbackConversations,
        executionEpoch: feedbackConversationExecutions.epoch,
        campaignResumeGeneration: feedbackCampaigns.resumeGeneration,
      })
      .from(feedbackConversations)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackConversations.campaignId, feedbackCampaigns.id),
      )
      .leftJoin(
        feedbackConversationExecutions,
        eq(
          feedbackConversations.id,
          feedbackConversationExecutions.conversationId,
        ),
      )
      .where(and(...filters))
      .orderBy(
        asc(feedbackConversations.workNextActionAt),
        asc(feedbackConversations.id),
      )
      .limit(limit);
    return rows.map((row) =>
      toDocument(row.conversation, derivedFromJoin(row)),
    );
  }

  /**
   * Records new durable work for this aggregate.
   *
   * The revision increment and replacement schedule are one SQL statement.
   */
  async markWorkDue(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly nextActionAt: Date;
      readonly at: Date;
    },
  ): Promise<FeedbackConversationWorkTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) => {
      const updated = applyMarkWorkDue(
        conversation,
        input.nextActionAt,
        input.at,
      );
      return workTransition(true, updated);
    });
  }

  /**
   * Makes every open conversation in a campaign durably discoverable.
   * One SQL UPDATE. No per-row campaign generation admission.
   */
  async markCampaignWorkDue(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly nextActionAt: Date;
      readonly at: Date;
    },
  ): Promise<number> {
    const updated = await transaction
      .update(feedbackConversations)
      .set({
        workRevision: sql`${feedbackConversations.workRevision} + 1`,
        workNextActionAt: sql`greatest(coalesce(${feedbackConversations.workNextActionAt}, ${input.nextActionAt}), ${input.nextActionAt})`,
        updatedAt: sql`greatest(${feedbackConversations.updatedAt}, ${input.at})`,
      })
      .where(
        and(
          eq(feedbackConversations.campaignId, input.campaignId),
          eq(feedbackConversations.lifecycleState, "open"),
        ),
      )
      .returning({ id: feedbackConversations.id });
    return updated.length;
  }

  /**
   * Settles one fenced execution and schedules whatever its planner saw next.
   *
   * `epoch` is accepted so the caller can keep the fence check in the same
   * transaction; it is not stored or compared on the conversation row.
   */
  async settleWorkExecution(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly revision: number;
      readonly epoch: number;
      readonly nextActionAt: Date | null;
      readonly at: Date;
    },
  ): Promise<FeedbackConversationWorkTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) => {
      const result = applySettleWorkExecution(conversation, {
        revision: input.revision,
        nextActionAt: input.nextActionAt,
        at: input.at,
      });
      return workTransition(result.changed, result.conversation);
    });
  }

  /**
   * Appends one transcript message. The append is idempotent by
   * `ingressId`/`outboxId` (or by the caller's stable id for system messages)
   * and keeps `seq` contiguous. The row lock replaces the old optimistic
   * size fence.
   */
  async appendMessage(
    transaction: AppTransaction,
    input: AppendFeedbackConversationMessageInput,
  ): Promise<FeedbackConversationAppendResult> {
    const dedupeKeys = messageIdentityKeys(input);
    if (dedupeKeys.length === 0) {
      throw new ConversationPersistenceError(
        "A feedback conversation message requires an ingress id, an outbox id or a stable id",
      );
    }
    const loaded = await this.requireForUpdate(
      transaction,
      input.conversationId,
    );
    const existing = loaded.conversation.messages.find((message) =>
      messageIdentityKeys(message).some((key) => dedupeKeys.includes(key)),
    );
    if (existing) {
      assertMessageIdentity(existing, input);
      return {
        appended: false,
        message: existing,
        conversation: loaded.conversation,
      };
    }

    const message: FeedbackConversationMessage = {
      id: input.id ?? randomUUID(),
      seq: loaded.conversation.messages.length + 1,
      actor: input.actor,
      text: input.text,
      providerMessageId: input.providerMessageId ?? null,
      ingressId: input.ingressId ?? null,
      outboxId: input.outboxId ?? null,
      attention: null,
      at: input.at,
    };
    const conversation = applyAppendMessage(loaded.conversation, message);
    await this.assertStoredMessagesFit(transaction, conversation, input.at);
    await this.writeDocument(transaction, conversation);
    return { appended: true, message, conversation };
  }

  async mergeMessageAttention(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly categories: readonly PostEventFeedbackSafetyCategory[];
      readonly recommendedAction: PostEventFeedbackRecommendedAction;
      readonly confidence: number;
      readonly at: Date;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    const loaded = await this.requireForUpdate(
      transaction,
      input.conversationId,
    );
    const result = applyMergeMessageAttention(loaded.conversation, input);
    if (result.changed) {
      await this.assertStoredMessagesFit(
        transaction,
        result.conversation,
        input.at,
      );
      await this.writeDocument(transaction, result.conversation);
    }
    return result;
  }

  async takeOver(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly source: Exclude<FeedbackConversationControlSource, "launch">;
      readonly at: Date;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyTakeOver(conversation, { source: input.source, at: input.at }),
    );
  }

  async markAwaitingHuman(
    transaction: AppTransaction,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyMarkAwaitingHuman(conversation, input.at),
    );
  }

  async recordHostileTurn(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly at: Date;
      readonly expectedCount: number;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyRecordHostileTurn(conversation, {
        expectedCount: input.expectedCount,
        at: input.at,
      }),
    );
  }

  async markExtractionFallbackAckSent(
    transaction: AppTransaction,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyMarkExtractionFallbackAckSent(conversation, input.at),
    );
  }

  async parkExtraction(
    transaction: AppTransaction,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyParkExtraction(conversation, input.at),
    );
  }

  async markExtractionParkedNoticeSent(
    transaction: AppTransaction,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyMarkExtractionParkedNoticeSent(conversation, input.at),
    );
  }

  async resumeBot(
    transaction: AppTransaction,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyResumeBot(conversation, input.at),
    );
  }

  async close(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly reason: FeedbackConversationLifecycleReason;
      readonly at: Date;
      readonly terminalOutboxId?: string | null;
      readonly staffClose?: FeedbackConversationDocument["staffClose"];
    },
  ): Promise<FeedbackConversationTransitionResult> {
    const terminalOutboxId = input.terminalOutboxId ?? null;
    if (terminalOutboxId && input.reason !== "stopped") {
      throw new FeedbackConversationTransitionError(
        "Only a STOP close may authorize an outbox row through close()",
      );
    }
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyClose(conversation, {
        reason: input.reason,
        at: input.at,
        terminalOutboxId,
        staffClose: input.staffClose,
      }),
    );
  }

  async advanceCursor(
    transaction: AppTransaction,
    input: FeedbackConversationAdvanceCursorInput,
  ): Promise<FeedbackConversationTransitionResult> {
    const expectedWork = expectedWorkFromInput(input);
    return this.mutate(
      transaction,
      input.conversationId,
      (conversation, fenceEpoch) =>
        applyAdvanceCursor(conversation, {
          toSeq: input.toSeq,
          at: input.at,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.serviceTier !== undefined
            ? { serviceTier: input.serviceTier }
            : {}),
          ...(input.usage ? { usage: input.usage } : {}),
          ...expectedWorkFence(expectedWork, fenceEpoch),
        }),
    );
  }

  async advanceCursorAndMarkAwaitingHuman(
    transaction: AppTransaction,
    input: FeedbackConversationAwaitHumanCursorInput,
  ): Promise<FeedbackConversationTransitionResult> {
    const expectedWork = expectedWorkFromInput(input);
    return this.mutate(
      transaction,
      input.conversationId,
      (conversation, fenceEpoch) =>
        applyAdvanceCursorAndMarkAwaitingHuman(conversation, {
          toSeq: input.toSeq,
          at: input.at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
          ...expectedWorkFence(expectedWork, fenceEpoch),
        }),
    );
  }

  async advanceCursorAndClose(
    transaction: AppTransaction,
    input: FeedbackConversationCloseCursorInput,
  ): Promise<FeedbackConversationTransitionResult> {
    const expectedWork = expectedWorkFromInput(input);
    return this.mutate(
      transaction,
      input.conversationId,
      (conversation, fenceEpoch) =>
        applyAdvanceCursorAndClose(conversation, {
          toSeq: input.toSeq,
          reason: input.reason,
          terminalOutboxId: input.terminalOutboxId,
          at: input.at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
          ...expectedWorkFence(expectedWork, fenceEpoch),
        }),
    );
  }

  async updateGoalStatuses(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly statuses: readonly {
        readonly key: FeedbackConversationGoal["key"];
        readonly status: FeedbackConversationGoal["status"];
      }[];
      readonly at: Date;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyUpdateGoalStatuses(conversation, {
        statuses: input.statuses,
        at: input.at,
      }),
    );
  }

  async raiseAttention(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly kind: PostEventFeedbackAttentionReason;
      readonly messageId: string | null;
      readonly at: Date;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyRaiseAttention(conversation, {
        kind: input.kind,
        messageId: input.messageId,
        at: input.at,
      }),
    );
  }

  async resolveAttentionReason(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly reasonId: string;
      readonly resolvedBy: string;
      readonly at: Date;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyResolveAttentionReason(conversation, {
        reasonId: input.reasonId,
        resolvedBy: input.resolvedBy,
        at: input.at,
      }),
    );
  }

  async markReminded(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly at: Date;
      readonly expectedCount: number;
    },
  ): Promise<FeedbackConversationTransitionResult> {
    return this.mutate(transaction, input.conversationId, (conversation) =>
      applyMarkReminded(conversation, {
        expectedCount: input.expectedCount,
        at: input.at,
      }),
    );
  }

  private async mutate<T extends FeedbackConversationTransitionResult>(
    transaction: AppTransaction,
    id: string,
    fn: (
      conversation: FeedbackConversationDocument,
      fenceEpoch: number | undefined,
    ) => T,
  ): Promise<T> {
    const loaded = await this.requireForUpdate(transaction, id);
    const result = fn(loaded.conversation, loaded.derived.executionEpoch);
    if (result.changed) {
      await this.writeDocument(transaction, result.conversation);
    }
    return result;
  }

  private async requireForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<{
    readonly conversation: FeedbackConversationDocument;
    readonly derived: FeedbackConversationDerived;
  }> {
    const loaded = await this.loadForUpdate(transaction, id);
    if (!loaded) {
      throw new FeedbackConversationNotFoundError(id);
    }
    return loaded;
  }

  private async loadForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<
    | {
        readonly conversation: FeedbackConversationDocument;
        readonly derived: FeedbackConversationDerived;
      }
    | undefined
  > {
    const [row] = await transaction
      .select()
      .from(feedbackConversations)
      .where(eq(feedbackConversations.id, id))
      .limit(1)
      .for("update");
    if (!row) {
      return undefined;
    }
    const derived = await this.loadDerived(transaction, row);
    return { conversation: toDocument(row, derived), derived };
  }

  private async selectDocument(
    executor: DatabaseExecutor,
    id: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    return this.selectDocumentBy(executor, eq(feedbackConversations.id, id));
  }

  private async selectDocumentBy(
    executor: DatabaseExecutor,
    where: ReturnType<typeof and> | ReturnType<typeof eq>,
  ): Promise<FeedbackConversationDocument | undefined> {
    const [row] = await executor
      .select({
        conversation: feedbackConversations,
        executionEpoch: feedbackConversationExecutions.epoch,
        campaignResumeGeneration: feedbackCampaigns.resumeGeneration,
      })
      .from(feedbackConversations)
      .innerJoin(
        feedbackCampaigns,
        eq(feedbackConversations.campaignId, feedbackCampaigns.id),
      )
      .leftJoin(
        feedbackConversationExecutions,
        eq(
          feedbackConversations.id,
          feedbackConversationExecutions.conversationId,
        ),
      )
      .where(where)
      .limit(1);
    return row ? toDocument(row.conversation, derivedFromJoin(row)) : undefined;
  }

  private async loadDerived(
    executor: DatabaseExecutor,
    row: Pick<FeedbackConversationRow, "id" | "campaignId">,
  ): Promise<FeedbackConversationDerived> {
    const [fence] = await executor
      .select({ epoch: feedbackConversationExecutions.epoch })
      .from(feedbackConversationExecutions)
      .where(eq(feedbackConversationExecutions.conversationId, row.id))
      .limit(1);
    const [campaign] = await executor
      .select({ resumeGeneration: feedbackCampaigns.resumeGeneration })
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.id, row.campaignId))
      .limit(1);
    return {
      ...(fence ? { executionEpoch: fence.epoch } : {}),
      ...(campaign
        ? { campaignResumeGeneration: campaign.resumeGeneration }
        : {}),
    };
  }

  private async writeDocument(
    transaction: AppTransaction,
    document: FeedbackConversationDocument,
  ): Promise<void> {
    await transaction
      .update(feedbackConversations)
      .set(toRowUpdate(document))
      .where(eq(feedbackConversations.id, document._id));
  }

  /**
   * Count/JSON precheck, then the authoritative CHECK
   * `pg_column_size(messages) <= 4194304`. Runs only on a changed messages
   * array so `raiseAttention` can persist `transcript_full` on the original
   * transcript without recursing.
   */
  private async assertStoredMessagesFit(
    transaction: AppTransaction,
    conversation: FeedbackConversationDocument,
    at: Date,
  ): Promise<void> {
    const storedMessages = serializeConversationJson(conversation).messages;
    if (
      conversationMessagesExceedCapacity(storedMessages) ||
      (await this.storedMessagesExceedPgColumnSize(transaction, storedMessages))
    ) {
      await this.raiseAttention(transaction, {
        conversationId: conversation._id,
        kind: "transcript_full",
        messageId: null,
        at,
      });
      throw new FeedbackConversationCapacityError();
    }
  }

  private async storedMessagesExceedPgColumnSize(
    transaction: AppTransaction,
    messages: readonly FeedbackConversationStoredMessage[],
  ): Promise<boolean> {
    const result = await transaction.execute<{ size: number }>(
      sql`select pg_column_size(cast(${JSON.stringify(messages)} as jsonb))::int as size`,
    );
    const { size } = result.rows[0]!;
    return size > FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES;
  }

  private executor(transaction?: AppTransaction): DatabaseExecutor {
    return transaction ?? this.database.db;
  }
}

function toDocumentFromLaunch(
  document: FeedbackConversationDocument,
  derived: FeedbackConversationDerived,
): FeedbackConversationDocument {
  const work = resolveFeedbackConversationWork(document.work);
  return {
    ...document,
    work: {
      ...work,
      executionEpoch: derived.executionEpoch ?? 0,
      ...(derived.campaignResumeGeneration !== undefined
        ? { campaignResumeGeneration: derived.campaignResumeGeneration }
        : {}),
    },
  };
}

function derivedFromJoin(row: {
  readonly executionEpoch: number | null;
  readonly campaignResumeGeneration: number | null;
}): FeedbackConversationDerived {
  return {
    ...(row.executionEpoch !== null
      ? { executionEpoch: row.executionEpoch }
      : {}),
    ...(row.campaignResumeGeneration !== null
      ? { campaignResumeGeneration: row.campaignResumeGeneration }
      : {}),
  };
}

function expectedWorkFence(
  expectedWork: FeedbackConversationExpectedWork | undefined,
  fenceEpoch: number | undefined,
): {
  readonly expectedWork?: FeedbackConversationExpectedWork;
  readonly fenceEpoch?: number;
} {
  if (!expectedWork) {
    return {};
  }
  return {
    expectedWork,
    ...(fenceEpoch !== undefined ? { fenceEpoch } : {}),
  };
}

function expectedWorkFromInput(input: {
  readonly workRevision?: number;
  readonly executionEpoch?: number;
}): FeedbackConversationExpectedWork | undefined {
  if (input.workRevision === undefined && input.executionEpoch === undefined) {
    return undefined;
  }
  if (input.workRevision === undefined || input.executionEpoch === undefined) {
    throw new FeedbackConversationTransitionError(
      "An execution fence requires both revision and epoch",
    );
  }
  return {
    revision: input.workRevision,
    epoch: input.executionEpoch,
  };
}

function workTransition(
  changed: boolean,
  conversation: FeedbackConversationDocument,
): FeedbackConversationWorkTransitionResult {
  return {
    changed,
    conversation,
    work: resolveFeedbackConversationWork(conversation.work),
  };
}

function excerptForSummary(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  if (collapsed.length <= FEEDBACK_SUMMARY_MESSAGE_EXCERPT_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, FEEDBACK_SUMMARY_MESSAGE_EXCERPT_MAX - 1)}…`;
}

function asCount(value: number | null | undefined): number {
  return Number(value ?? 0);
}
