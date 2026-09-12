import { Injectable } from "@nestjs/common";
import type {
  FeedbackAnswerQuestionKey,
  FeedbackCampaignRow,
  FeedbackNoteType,
  MessageOutboxStatus,
} from "@slopform/database";

import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { resolveCampaignCopy } from "../question-set.js";
import { isCorrectedAnswer } from "./answer-corrections.js";
import { FeedbackExtractionGuards } from "./extraction-guards.service.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import type { ExtractRunSnapshot } from "./extract.types.js";
import {
  buildFeedbackExtractionPrompt,
  estimatePromptTokens,
} from "./prompt.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import type { PreparedModelContext } from "./turn-planning.types.js";

/** Delivered or in-flight outbound. Missing historical rows stay visible. */
const FEEDBACK_MODEL_VISIBLE_OUTBOX_STATUSES = new Set<MessageOutboxStatus>([
  "attempting",
  "ambiguous",
  "sending",
  "sent",
]);

/**
 * Builds the live extraction prompt and the provider-entry guard. Does not
 * call the model.
 */
@Injectable()
export class FeedbackModelContextBuilder {
  constructor(
    private readonly events: EventsService,
    private readonly results: FeedbackResultsRepository,
    private readonly participants: ParticipantsRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly guards: FeedbackExtractionGuards,
  ) {}

  async prepare(snapshot: ExtractRunSnapshot): Promise<PreparedModelContext> {
    const context = await this.buildContext(
      snapshot.conversation,
      snapshot.campaign,
    );
    const copy = resolveCampaignCopy(
      snapshot.campaign.questions,
      snapshot.campaign.questionSetVersion,
    );
    const prompt = buildFeedbackExtractionPrompt({ context, copy });
    const executionClaim = snapshot.executionClaim;
    return {
      context,
      copy,
      prompt,
      estimatedPromptTokens: estimatePromptTokens(prompt),
      beforeProviderCall: () =>
        this.guards.assertProviderEntry(executionClaim, snapshot.conversation),
    };
  }

  private async buildContext(
    conversation: FeedbackConversationDocument,
    campaign: FeedbackCampaignRow,
  ): Promise<FeedbackExtractionContext> {
    const transcriptOutboxIds = conversation.messages.flatMap((message) =>
      message.outboxId ? [message.outboxId] : [],
    );
    // Six live reads together; visibility is decided after statuses return.
    const [
      candidates,
      acceptedAnswers,
      acceptedNotes,
      participant,
      venue,
      outboxStatuses,
    ] = await Promise.all([
      this.events.listFeedbackCandidatesForRespondent(
        campaign.eventId,
        conversation.respondentParticipantId,
      ),
      this.results.listAnswersByConversation(conversation._id),
      this.results.listNotesByConversation(conversation._id),
      this.participants.findById(conversation.respondentParticipantId),
      this.events.getFeedbackVenueContext(campaign.eventId),
      this.outbox.listOutboxStatusesByIds(transcriptOutboxIds),
    ]);
    const outboxStatusById = new Map(
      outboxStatuses.map(({ outboxId, status }) => [outboxId, status]),
    );
    const modelVisibleMessages = conversation.messages.filter((message) => {
      if (message.actor === "participant" || !message.outboxId) return true;

      const status = outboxStatusById.get(message.outboxId);
      return (
        status === undefined ||
        FEEDBACK_MODEL_VISIBLE_OUTBOX_STATUSES.has(status)
      );
    });

    return {
      respondentParticipantId: conversation.respondentParticipantId,
      respondentDisplayName: participant?.preferredName?.trim() || null,
      candidates: candidates.items,
      messages: modelVisibleMessages.map((message) => ({
        id: message.id,
        seq: message.seq,
        actor: message.actor,
        occurredAt: message.at.toISOString(),
        text: message.text,
      })),
      // Unread testimony follows the cursor on the full transcript.
      newParticipantMessageIds: conversation.messages
        .filter(
          (message) =>
            message.actor === "participant" &&
            message.seq > conversation.extraction.cursorSeq,
        )
        .map((message) => message.id),
      goals: conversation.goals,
      acceptedAnswers: acceptedAnswers.map((answer) => ({
        questionKey: answer.questionKey as FeedbackAnswerQuestionKey,
        subjectParticipantId: answer.subjectParticipantId,
        valueInt: answer.valueInt,
        correctedByOperator: isCorrectedAnswer(answer.extractionMeta),
      })),
      acceptedNotes: acceptedNotes.map((note) => ({
        noteType: note.noteType as FeedbackNoteType,
        text: note.text,
        subjectParticipantId: note.subjectParticipantId,
      })),
      venue: venue.venue,
      venueContextRevision: venue.venue === null ? null : venue.contextRevision,
      replyAllowed:
        conversation.lifecycle.state === "open" &&
        conversation.control.mode === "bot" &&
        participant?.postEventFeedbackWhatsappOptIn === true &&
        campaign.status === "launched",
    };
  }
}
