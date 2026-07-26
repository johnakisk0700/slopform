import { Injectable, Logger } from "@nestjs/common";
import type { FeedbackCampaignRow } from "@join-the-six/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FeedbackConversationPhoneConflictError,
  FeedbackConversationRepository,
} from "../conversations/feedback-conversation.repository.js";
import {
  buildFeedbackConversationGoals,
  type FeedbackConversationDocument,
} from "../conversations/feedback-conversation.schemas.js";
import { EventsRepository } from "../events/events.repository.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import type {
  FeedbackCampaignListItemView,
  FeedbackCampaignListView,
  FeedbackCampaignView,
  StartFeedbackConversationResultView,
} from "./post-event-feedback-campaign.schemas.js";
import {
  buildPostEventFeedbackQuestionLaunchSnapshot,
  createFeedbackIntroDedupeKey,
  renderPostEventFeedbackCopy,
  type PostEventFeedbackQuestionSetCopy,
} from "./post-event-feedback-question-set.js";
import {
  PostEventFeedbackRepository,
  type FeedbackEligibleAttendee,
} from "./post-event-feedback.repository.js";

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
 * intro rows go through `message_outbox`; WP6's relay sends them.
 */
@Injectable()
export class PostEventFeedbackCampaignService {
  private readonly logger = new Logger(PostEventFeedbackCampaignService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PostEventFeedbackRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsRepository,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
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
    const rows = await this.repository.listCampaignsNewestFirst();
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
      await this.repository.listEligibleAttendeesForEvent(eventId);
    const existing = await this.repository.findCampaignByEventId(eventId);

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
    const copy = snapshot.copy;

    const campaign = existing
      ? existing
      : await this.database.transaction(async (transaction) => {
          const created = await this.repository.createCampaign(transaction, {
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
          campaign,
          attendee,
          copy,
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
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status === "closed") {
      const summaries = await this.conversations.listForCampaign(campaign.id);
      return toCampaignView(campaign, summaries.length, 0);
    }

    const updated = await this.database.transaction(async (transaction) => {
      const next = await this.repository.updateCampaignStatus(
        transaction,
        campaign.id,
        "closed",
      );
      if (!next) {
        throw new FeedbackCampaignNotFoundError(campaignId);
      }
      const cancelledOutboxCount =
        await this.repository.cancelQueuedOutboxForCampaign(
          transaction,
          campaign.id,
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

    const eligible = await this.repository.listEligibleAttendeesForEvent(
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

    const snapshot = resolveLaunchCopy(campaign);
    const result = await this.ensureConversationAndIntro({
      campaign,
      attendee,
      copy: snapshot,
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
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status === "closed") {
      throw new FeedbackCampaignMutationNotAllowedError(
        "A closed campaign cannot change status",
      );
    }
    if (campaign.status === to) {
      const summaries = await this.conversations.listForCampaign(campaign.id);
      return toCampaignView(campaign, summaries.length, 0);
    }

    const updated = await this.database.transaction(async (transaction) => {
      const next = await this.repository.updateCampaignStatus(
        transaction,
        campaign.id,
        to,
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

    const summaries = await this.conversations.listForCampaign(updated.id);
    return toCampaignView(updated, summaries.length, 0);
  }

  private async ensureConversationAndIntro(input: {
    readonly campaign: FeedbackCampaignRow;
    readonly attendee: FeedbackEligibleAttendee;
    readonly copy: PostEventFeedbackQuestionSetCopy;
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
    const goals = buildFeedbackConversationGoals(input.copy);
    const creation = await this.conversations.createFromLaunch({
      campaignId: input.campaign.id,
      respondentParticipantId: input.attendee.participantId,
      phoneAtLaunch: input.attendee.phoneE164,
      launchedAt: input.launchedAt,
      goals,
    });

    // A STOP-closed conversation is returned as-is and must never get a new
    // intro (D6 / D17).
    if (
      !creation.created &&
      creation.conversation.lifecycle.state === "closed"
    ) {
      return {
        conversation: creation.conversation,
        created: false,
        introEnqueued: false,
      };
    }

    let introEnqueued = false;
    if (creation.conversation.lifecycle.state === "open") {
      const intro = await this.database.transaction(async (transaction) => {
        const enqueued = await this.repository.insertOutboxIfAbsent(
          transaction,
          {
            conversationId: creation.conversation._id,
            campaignId: input.campaign.id,
            kind: "intro",
            body: renderPostEventFeedbackCopy(input.copy.intro, displayName),
            dedupeKey: createFeedbackIntroDedupeKey(creation.conversation._id),
          },
        );

        if (creation.created && input.auditOnCreate) {
          await this.audit.append(transaction, {
            actorType: "admin",
            actorId: input.actorId,
            action: input.action ?? "feedback_conversation.created",
            entityType: "feedback_conversation",
            entityId: creation.conversation._id,
            requestId: input.requestId,
            context: {
              campaignId: input.campaign.id,
              participantId: input.attendee.participantId,
              introOutboxId: enqueued.row.id,
              introInserted: enqueued.inserted,
            },
          });
        }

        return enqueued;
      });

      // Runs whether or not this call inserted the row: a launch that crashed
      // between the committed intro and the MongoDB append repairs itself here
      // on replay, and an already-recorded intro is an idempotent no-op.
      await this.outboundTranscript.record(intro.row, input.launchedAt);

      introEnqueued = intro.inserted;
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
    const campaign = await this.repository.findCampaignById(campaignId);
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

function resolveLaunchCopy(
  campaign: FeedbackCampaignRow,
): PostEventFeedbackQuestionSetCopy {
  const questions = campaign.questions as {
    copy?: PostEventFeedbackQuestionSetCopy;
  };
  if (questions.copy) {
    return questions.copy;
  }
  return buildPostEventFeedbackQuestionLaunchSnapshot().copy;
}
