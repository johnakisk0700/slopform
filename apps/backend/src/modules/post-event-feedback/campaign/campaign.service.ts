import { Injectable, Logger } from "@nestjs/common";
import type { FeedbackCampaignRow } from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackCampaignRepository,
  type FeedbackEligibleAttendee,
} from "./campaign.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import {
  FeedbackConversationPhoneConflictError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import {
  buildFeedbackConversationGoals,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { EventsRepository } from "../../events/events.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import type {
  FeedbackCampaignListItemView,
  FeedbackCampaignListView,
  FeedbackCampaignView,
  StartFeedbackConversationResultView,
} from "./campaign.schemas.js";
import {
  buildPostEventFeedbackQuestionLaunchSnapshot,
  createFeedbackIntroDedupeKey,
  getPostEventFeedbackQuestionSet,
  renderPostEventFeedbackCopy,
  resolveCampaignCopy,
} from "../question-set.js";
import { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";
import { FeedbackCampaignResumeRepairService } from "./resume-repair.service.js";

export class FeedbackCampaignNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback campaign ${id} was not found`);
    this.name = FeedbackCampaignNotFoundError.name;
  }
}

export class FeedbackCampaignEventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Event ${eventId} was not found`);
    this.name = FeedbackCampaignEventNotFoundError.name;
  }
}

export class FeedbackCampaignLaunchNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FeedbackCampaignLaunchNotAllowedError.name;
  }
}

export class FeedbackCampaignMutationNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FeedbackCampaignMutationNotAllowedError.name;
  }
}

export class FeedbackCampaignParticipantNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FeedbackCampaignParticipantNotEligibleError.name;
  }
}

/**
 * Staff-facing campaign application service (WP7). Owns launch, the pause /
 * resume / close kill switch, and the D17 start-conversation action. Outbound
 * intro rows go through `message_outbox`; the direct dispatcher sends them.
 */
@Injectable()
export class PostEventFeedbackCampaignService {
  private readonly logger = new Logger(PostEventFeedbackCampaignService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsRepository,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundLog: FeedbackOutboundLogService,
    private readonly wakeups: FeedbackConversationWakeupService,
    private readonly resumeRepairs: FeedbackCampaignResumeRepairService,
  ) {}

  async get(campaignId: string): Promise<FeedbackCampaignView> {
    const campaign = await this.requireCampaign(campaignId);
    const summaries = await this.conversations.listForCampaign(campaign.id);
    return toCampaignView(campaign, summaries.length, 0);
  }

  /**
   * Read-only campaign picker. Newest launch first; progress counts come from
   * the same compact Mongo projections the inbox list uses. Never launches or
   * enqueues intros — that remains `launch` / `startConversation` only.
   */
  async list(): Promise<FeedbackCampaignListView> {
    const rows = await this.campaigns.listCampaignsNewestFirst();
    const items: FeedbackCampaignListItemView[] = await Promise.all(
      rows.map(async (row) => {
        const summaries = await this.conversations.listForCampaign(
          row.campaign.id,
        );
        return {
          id: row.campaign.id,
          eventId: row.campaign.eventId,
          eventTitle: row.eventTitle,
          status: row.campaign.status as FeedbackCampaignListItemView["status"],
          launchedAt: row.campaign.launchedAt.toISOString(),
          conversationCount: summaries.length,
          openCount: summaries.filter(
            (summary) => summary.lifecycle.state === "open",
          ).length,
          needsAttentionCount: summaries.filter(
            (summary) => summary.needsAttention,
          ).length,
          extractionParkedCount: summaries.filter(
            (summary) => summary.extractionParked,
          ).length,
        };
      }),
    );

    return { items };
  }

  /**
   * Launch gate: finished event ∧ ≥1 eligible attendee (present ∧ opt-in ∧
   * phone). Replay-safe: a second call returns the existing campaign and
   * create-if-missing conversations / intro rows without duplicating them.
   */
  async launch(
    eventId: string,
    actorId: string,
    requestId: string,
  ): Promise<FeedbackCampaignView> {
    const event = await this.events.findById(eventId);
    if (!event) {
      throw new FeedbackCampaignEventNotFoundError(eventId);
    }
    if (event.status !== "finished") {
      throw new FeedbackCampaignLaunchNotAllowedError(
        `Campaign launch requires a finished event (status=${event.status})`,
      );
    }

    const eligible =
      await this.campaigns.listEligibleAttendeesForEvent(eventId);
    const existing = await this.campaigns.findCampaignByEventId(eventId);

    if (!existing && eligible.length === 0) {
      throw new FeedbackCampaignLaunchNotAllowedError(
        "Campaign launch requires at least one eligible attendee (present, opted in, with phone)",
      );
    }

    if (existing && existing.status === "closed") {
      throw new FeedbackCampaignLaunchNotAllowedError(
        "A closed campaign cannot be relaunched",
      );
    }

    const launchedAt = existing?.launchedAt ?? new Date();
    const snapshot = buildPostEventFeedbackQuestionLaunchSnapshot();

    const campaign = existing
      ? existing
      : await this.database.transaction(async (transaction) => {
          const created = await this.campaigns.createCampaign(transaction, {
            eventId,
            questionSetVersion: snapshot.questionSetVersion,
            questions: snapshot,
            launchedAt,
            launchedBy: actorId,
            status: "launched",
          });
          await this.audit.append(transaction, {
            actorType: "admin",
            actorId,
            action: "feedback_campaign.launched",
            entityType: "feedback_campaign",
            entityId: created.id,
            requestId,
            context: {
              eventId,
              questionSetVersion: snapshot.questionSetVersion,
              eligibleCount: eligible.length,
            },
          });
          return created;
        });
    // One attendee's phone conflict must not abandon the launch. The partial
    // unique index allows a single open conversation per number, so a stale row
    // — or two attendees sharing a handset — used to throw out of this loop and
    // leave a campaign half-launched: some people had their intro, the rest
    // never would, and re-running produced the same failure at the same
    // attendee. Skipping and reporting keeps the launch complete for everyone
    // else and leaves an operator something to act on.
    let conversationsCreated = 0;
    const phoneConflicts: string[] = [];
    for (const attendee of eligible) {
      let result;
      try {
        result = await this.ensureConversationAndIntro({
          campaignId: campaign.id,
          attendee,
          launchedAt,
          actorId,
          requestId,
          auditOnCreate: true,
        });
      } catch (error) {
        if (!(error instanceof FeedbackConversationPhoneConflictError)) {
          throw error;
        }
        phoneConflicts.push(attendee.participantId);
        this.logger.warn({
          event: "feedback.campaign.launch_phone_conflict",
          requestId,
          campaignId: campaign.id,
          participantId: attendee.participantId,
        });
        continue;
      }
      if (result.created) {
        conversationsCreated += 1;
      }
    }

    if (phoneConflicts.length > 0) {
      await this.database.transaction((transaction) =>
        this.audit.append(transaction, {
          actorType: "staff",
          actorId,
          action: "feedback_campaign.launch_phone_conflicts",
          entityType: "feedback_campaign",
          entityId: campaign.id,
          requestId,
          context: { eventId, participantIds: phoneConflicts },
        }),
      );
    }

    const summaries = await this.conversations.listForCampaign(campaign.id);
    return toCampaignView(campaign, summaries.length, conversationsCreated);
  }

  async pause(
    campaignId: string,
    actorId: string,
    requestId: string,
  ): Promise<FeedbackCampaignView> {
    return this.transitionStatus(campaignId, "paused", actorId, requestId);
  }

  async resume(
    campaignId: string,
    actorId: string,
    requestId: string,
  ): Promise<FeedbackCampaignView> {
    return this.transitionStatus(campaignId, "launched", actorId, requestId);
  }

  /**
   * Kill-switch close: stops leasing and cancels queued outbox rows. Open
   * conversations are left for STOP / expiry / staff close (D17).
   */
  async close(
    campaignId: string,
    actorId: string,
    requestId: string,
  ): Promise<FeedbackCampaignView> {
    const updated = await this.database.transaction(async (transaction) => {
      // Status validation belongs under the row lock. A pause/resume request
      // that read an older state must never overwrite a close that committed
      // while it was waiting for this transaction.
      const campaign = await this.campaigns.findCampaignByIdForUpdate(
        transaction,
        campaignId,
      );
      if (!campaign) {
        throw new FeedbackCampaignNotFoundError(campaignId);
      }
      if (campaign.status === "closed") {
        return campaign;
      }
      const next = await this.campaigns.updateCampaignStatus(
        transaction,
        campaign.id,
        "closed",
      );
      if (!next) {
        throw new FeedbackCampaignNotFoundError(campaignId);
      }
      // STOP and campaign close share this campaign row lock. If STOP wins,
      // MongoDB already names the one acknowledgement that remains owed; if
      // close wins, its cancellation commits before STOP can insert anything.
      // Either order preserves exactly the anchored row and no generic system
      // message exception leaks through the kill switch.
      const preservedStopAcknowledgements =
        await this.conversations.listStopTerminalOutboxIdsForCampaign(
          campaign.id,
        );
      const cancelledOutboxCount =
        await this.outbox.cancelQueuedOutboxForCampaign(
          transaction,
          campaign.id,
          preservedStopAcknowledgements,
        );
      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "feedback_campaign.closed",
        entityType: "feedback_campaign",
        entityId: campaign.id,
        requestId,
        context: {
          from: campaign.status,
          to: "closed",
          cancelledOutboxCount,
        },
      });
      return next;
    });

    const summaries = await this.conversations.listForCampaign(updated.id);
    return toCampaignView(updated, summaries.length, 0);
  }

  /**
   * D17 create-if-missing for one late-added / previously ineligible
   * participant. Never recreates a STOP-closed conversation.
   */
  async startConversation(
    campaignId: string,
    participantId: string,
    actorId: string,
    requestId: string,
  ): Promise<StartFeedbackConversationResultView> {
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status === "closed") {
      throw new FeedbackCampaignMutationNotAllowedError(
        "Cannot start a conversation on a closed campaign",
      );
    }

    const eligible = await this.campaigns.listEligibleAttendeesForEvent(
      campaign.eventId,
    );
    const attendee = eligible.find(
      (candidate) => candidate.participantId === participantId,
    );
    if (!attendee) {
      throw new FeedbackCampaignParticipantNotEligibleError(
        `Participant ${participantId} is not eligible (present ∧ opt-in ∧ phone)`,
      );
    }

    const result = await this.ensureConversationAndIntro({
      campaignId: campaign.id,
      attendee,
      launchedAt: new Date(),
      actorId,
      requestId,
      auditOnCreate: true,
      action: "feedback_conversation.started",
    });

    return {
      campaignId: campaign.id,
      conversationId: result.conversation._id,
      participantId,
      created: result.created,
      lifecycleState: result.conversation.lifecycle.state,
      introEnqueued: result.introEnqueued,
    };
  }

  private async transitionStatus(
    campaignId: string,
    to: "launched" | "paused",
    actorId: string,
    requestId: string,
  ): Promise<FeedbackCampaignView> {
    const resumeDueAt = to === "launched" ? new Date() : undefined;
    const updated = await this.database.transaction(async (transaction) => {
      const campaign = await this.campaigns.findCampaignByIdForUpdate(
        transaction,
        campaignId,
      );
      if (!campaign) {
        throw new FeedbackCampaignNotFoundError(campaignId);
      }
      if (campaign.status === "closed") {
        throw new FeedbackCampaignMutationNotAllowedError(
          "A closed campaign cannot change status",
        );
      }
      if (campaign.status === to) {
        return campaign;
      }
      const next = await this.campaigns.updateCampaignStatus(
        transaction,
        campaign.id,
        to,
        resumeDueAt ? { resumeDueAt } : undefined,
      );
      if (!next) {
        throw new FeedbackCampaignNotFoundError(campaignId);
      }
      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action:
          to === "paused"
            ? "feedback_campaign.paused"
            : "feedback_campaign.resumed",
        entityType: "feedback_campaign",
        entityId: campaign.id,
        requestId,
        context: { from: campaign.status, to },
      });
      return next;
    });

    if (to === "launched") {
      // The status transaction persisted a resume generation first. This
      // immediate repair is only a latency optimization; maintenance can
      // complete the exact same idempotent hand-off after any crash here.
      await this.resumeRepairs.repairCampaign(updated.id, requestId);
    }
    const summaries = await this.conversations.listForCampaign(updated.id);
    return toCampaignView(updated, summaries.length, 0);
  }

  private async ensureConversationAndIntro(input: {
    readonly campaignId: string;
    readonly attendee: FeedbackEligibleAttendee;
    readonly launchedAt: Date;
    readonly actorId: string;
    readonly requestId: string;
    readonly auditOnCreate: boolean;
    readonly action?: string;
  }): Promise<{
    readonly conversation: FeedbackConversationDocument;
    readonly created: boolean;
    readonly introEnqueued: boolean;
  }> {
    const displayName =
      input.attendee.preferredName?.trim() || input.attendee.emailNormalized;
    const { creation, intro } = await this.database.transaction(
      async (transaction) => {
        // This lock orders launch/start against the kill switch across the
        // complete producer boundary. If close won, no Mongo conversation is
        // created. If this producer won, close waits and then cancels the intro
        // row committed here. Holding a short PostgreSQL transaction over one
        // idempotent Mongo create is deliberate cross-store serialization; no
        // provider or queue call occurs while the lock is held.
        const campaign = await this.campaigns.findCampaignByIdForUpdate(
          transaction,
          input.campaignId,
        );
        if (!campaign) {
          throw new FeedbackCampaignNotFoundError(input.campaignId);
        }
        if (campaign.status === "closed") {
          throw new FeedbackCampaignMutationNotAllowedError(
            "Cannot start a conversation on a closed campaign",
          );
        }

        const copy = resolveCampaignCopy(
          campaign.questions,
          campaign.questionSetVersion,
        );
        const questionSet = getPostEventFeedbackQuestionSet(
          campaign.questionSetVersion,
        );
        const goals = buildFeedbackConversationGoals(copy, questionSet.version);
        const creation = await this.conversations.createFromLaunch({
          campaignId: campaign.id,
          respondentParticipantId: input.attendee.participantId,
          phoneAtLaunch: input.attendee.phoneE164,
          launchedAt: input.launchedAt,
          goals,
        });

        // A STOP-closed conversation is returned as-is and must never get a
        // new intro (D6 / D17).
        if (
          !creation.created &&
          creation.conversation.lifecycle.state === "closed"
        ) {
          return { creation, intro: undefined };
        }

        if (creation.conversation.lifecycle.state !== "open") {
          return { creation, intro: undefined };
        }

        const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
          conversationId: creation.conversation._id,
          campaignId: campaign.id,
          kind: "intro",
          body: renderPostEventFeedbackCopy(copy.intro, displayName),
          dedupeKey: createFeedbackIntroDedupeKey(creation.conversation._id),
        });
        await this.outboundLog.record(transaction, {
          outbox: enqueued,
          conversation: creation.conversation,
          decision: {
            origin: "campaign_intro",
            conversationCreated: creation.created,
          },
          correlationId: input.requestId,
        });

        if (creation.created && input.auditOnCreate) {
          await this.audit.append(transaction, {
            actorType: "admin",
            actorId: input.actorId,
            action: input.action ?? "feedback_conversation.created",
            entityType: "feedback_conversation",
            entityId: creation.conversation._id,
            requestId: input.requestId,
            context: {
              campaignId: campaign.id,
              participantId: input.attendee.participantId,
              introOutboxId: enqueued.row.id,
              introInserted: enqueued.inserted,
            },
          });
        }

        return { creation, intro: enqueued };
      },
    );

    let introEnqueued = false;
    if (intro) {
      // Runs whether or not this call inserted the row: a launch that crashed
      // between the committed intro and the MongoDB append repairs itself here
      // on replay, and an already-recorded intro is an idempotent no-op.
      await this.outboundTranscript.record(intro.row, input.launchedAt);

      introEnqueued = intro.inserted;
    }

    if (
      creation.conversation.lifecycle.state === "open" &&
      (creation.created || !creation.conversation.work?.nextActionAt)
    ) {
      await this.wakeups.schedule({
        conversationId: creation.conversation._id,
        nextActionAt: input.launchedAt,
        correlationId: input.requestId,
        at: input.launchedAt,
      });
    }

    return {
      conversation: creation.conversation,
      created: creation.created,
      introEnqueued,
    };
  }

  private async requireCampaign(
    campaignId: string,
  ): Promise<FeedbackCampaignRow> {
    const campaign = await this.campaigns.findCampaignById(campaignId);
    if (!campaign) {
      throw new FeedbackCampaignNotFoundError(campaignId);
    }
    return campaign;
  }
}

function toCampaignView(
  campaign: FeedbackCampaignRow,
  conversationCount: number,
  conversationsCreated: number,
): FeedbackCampaignView {
  return {
    id: campaign.id,
    eventId: campaign.eventId,
    questionSetVersion: campaign.questionSetVersion,
    status: campaign.status as FeedbackCampaignView["status"],
    launchedAt: campaign.launchedAt.toISOString(),
    launchedBy: campaign.launchedBy,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    conversationCount,
    conversationsCreated,
  };
}
