import { Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackCampaignRow,
  FeedbackExtractionMeta,
} from "@join-the-six/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import type {
  FeedbackConversationDocument,
  FeedbackConversationGoal,
} from "../conversations/feedback-conversation.schemas.js";
import { EventsService } from "../events/events.service.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackExtractOutcome,
} from "./post-event-feedback-metrics.service.js";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  type PostEventFeedbackAnswerQuestionKey,
  type PostEventFeedbackNoteType,
  type PostEventFeedbackQuestionSetCopy,
} from "./post-event-feedback-question-set.js";
import { validateFeedbackExtractionProposal } from "./post-event-feedback-extraction-validation.js";
import { PostEventFeedbackExtractionModel } from "./post-event-feedback-extraction.service.js";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  createFeedbackClosingDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackReplyDedupeKey,
  type FeedbackExtractionContext,
  type ValidatedFeedbackExtraction,
} from "./post-event-feedback-extraction.schemas.js";
import {
  buildFeedbackExtractionPrompt,
  estimateFeedbackExtractionTokens,
} from "./post-event-feedback-prompt.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";

export class PostEventFeedbackConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Feedback conversation ${conversationId} was not found`);
    this.name = PostEventFeedbackConversationNotFoundError.name;
  }
}

export class PostEventFeedbackCampaignNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Feedback campaign ${campaignId} was not found`);
    this.name = PostEventFeedbackCampaignNotFoundError.name;
  }
}

export interface ExtractFeedbackInput {
  readonly conversationId: string;
  readonly correlationId: string;
}

export interface ExtractFeedbackResult {
  readonly outcome: FeedbackExtractOutcome;
  readonly conversationId: string;
  readonly cursorSeq: number;
  readonly answersWritten: number;
  readonly notesWritten: number;
  readonly outboxId?: string;
  readonly model?: string;
}

/**
 * `feedback.extract.v1` — the model turn of the post-event feedback loop.
 *
 * The run is serialized per conversation by the queue's deterministic job id
 * (`feedback-extract-v1-<conversationId>-<latestSeq>`) and made replay-safe by
 * the MongoDB extraction cursor. It reloads every authoritative fact, selects
 * candidates **live** from current attendance (D16), asks the model for a
 * proposal, validates that proposal against the domain rules and only then
 * writes anything.
 *
 * Store order is PostgreSQL first, MongoDB cursor last, and deliberately so.
 * The cursor is the idempotency fence: advancing it before the results were
 * durable would silently drop them, whereas a crash after the PostgreSQL commit
 * replays into inserts that the unique constraints, the note content signature
 * and the outbox `dedupe_key` all absorb. That costs one repeated model call —
 * a repeated bill, never a duplicated answer or a second WhatsApp message.
 * Nothing here claims exactly-once.
 */
@Injectable()
export class PostEventFeedbackExtractor {
  private readonly logger = new Logger(PostEventFeedbackExtractor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PostEventFeedbackRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly audit: AuditRepository,
    private readonly metrics: PostEventFeedbackMetrics,
  ) {}

  async extract(input: ExtractFeedbackInput): Promise<ExtractFeedbackResult> {
    const conversation = await this.conversations.findById(
      input.conversationId,
    );
    if (!conversation) {
      throw new PostEventFeedbackConversationNotFoundError(
        input.conversationId,
      );
    }

    const cursorSeq = conversation.messages.length;
    const skipped = this.resolveSkip(conversation, cursorSeq);
    if (skipped) {
      return this.complete(
        {
          outcome: skipped,
          conversationId: conversation._id,
          cursorSeq: conversation.extraction.cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }

    // Bot prompts and staff follow-ups are context, never testimony, so a
    // transcript that gained nothing from the participant needs no model call.
    // The cursor still advances: those messages are read and settled.
    const pending = conversation.messages.filter(
      (message) => message.seq > conversation.extraction.cursorSeq,
    );
    if (!pending.some((message) => message.actor === "participant")) {
      await this.conversations.advanceCursor({
        conversationId: conversation._id,
        toSeq: cursorSeq,
        at: new Date(),
        model: conversation.extraction.model,
      });
      return this.complete(
        {
          outcome: "skipped_no_new_testimony",
          conversationId: conversation._id,
          cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }

    const campaign = await this.repository.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      throw new PostEventFeedbackCampaignNotFoundError(conversation.campaignId);
    }

    const context = await this.buildContext(conversation, campaign);
    const copy = resolveQuestionCopy(campaign.questions);
    const prompt = buildFeedbackExtractionPrompt({ context, copy });
    const estimatedPromptTokens = estimateFeedbackExtractionTokens(prompt);

    const generated = await this.generation.propose(prompt);
    this.metrics.recordExtractTokens(
      {
        model: generated.model,
        estimatedPromptTokens,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        totalTokens: generated.usage.totalTokens,
      },
      input.correlationId,
    );

    const validated = validateFeedbackExtractionProposal(
      generated.proposal,
      context,
    );
    if (validated.rejections.length > 0) {
      this.logger.warn({
        event: "feedback.extract.rejected_proposals",
        correlationId: input.correlationId,
        conversationId: conversation._id,
        rejections: validated.rejections,
      });
    }

    const goalStatuses = resolveGoalStatuses(
      conversation.goals,
      context,
      validated,
    );
    const completing = isCompleting(conversation.goals, goalStatuses);
    const outbound = this.resolveOutbound(
      conversation,
      validated,
      completing,
      cursorSeq,
      copy,
    );

    const written = await this.persist({
      conversation,
      campaign,
      context,
      validated,
      outbound,
      model: generated.model,
      correlationId: input.correlationId,
    });

    await this.applyConversationState({
      conversation,
      validated,
      goalStatuses,
      completing,
      cursorSeq,
      model: generated.model,
    });

    return this.complete(
      {
        outcome: completing
          ? "completed"
          : validated.safetySignal || validated.handoff
            ? "handoff"
            : "extracted",
        conversationId: conversation._id,
        cursorSeq,
        answersWritten: written.answersWritten,
        notesWritten: written.notesWritten,
        ...(written.outboxId ? { outboxId: written.outboxId } : {}),
        model: generated.model,
      },
      input.correlationId,
    );
  }

  /**
   * The three cheap exits from §7. Each one is reloaded state rather than a
   * queue assumption, because the job may have waited behind a STOP, a staff
   * takeover or a newer run for the same conversation.
   */
  private resolveSkip(
    conversation: FeedbackConversationDocument,
    latestSeq: number,
  ): FeedbackExtractOutcome | undefined {
    if (conversation.lifecycle.state === "closed") {
      return "skipped_closed";
    }
    if (conversation.control.mode === "human") {
      return "skipped_human_control";
    }
    if (conversation.extraction.cursorSeq >= latestSeq) {
      return "skipped_cursor";
    }
    return undefined;
  }

  private async buildContext(
    conversation: FeedbackConversationDocument,
    campaign: FeedbackCampaignRow,
  ): Promise<FeedbackExtractionContext> {
    // D16: selected now, from current attendance. The conversation stores no
    // candidate list, so «ξεχάσαμε τη Ρούλα» reaches this turn as soon as
    // attendance is corrected.
    const candidates = await this.events.listFeedbackCandidatesForRespondent(
      campaign.eventId,
      conversation.respondentParticipantId,
    );
    const [acceptedAnswers, acceptedNotes, participant] = await Promise.all([
      this.repository.listAnswersByConversation(conversation._id),
      this.repository.listNotesByConversation(conversation._id),
      this.participants.findById(conversation.respondentParticipantId),
    ]);

    return {
      respondentParticipantId: conversation.respondentParticipantId,
      candidates: candidates.items,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        seq: message.seq,
        actor: message.actor,
        text: message.text,
      })),
      goals: conversation.goals,
      acceptedAnswers: acceptedAnswers.map((answer) => ({
        questionKey: answer.questionKey as PostEventFeedbackAnswerQuestionKey,
        subjectParticipantId: answer.subjectParticipantId,
        valueInt: answer.valueInt,
      })),
      acceptedNotes: acceptedNotes.map((note) => ({
        noteType: note.noteType as PostEventFeedbackNoteType,
        text: note.text,
        subjectParticipantId: note.subjectParticipantId,
      })),
      // AI output can never send, change consent or bypass this gate.
      replyAllowed:
        conversation.lifecycle.state === "open" &&
        conversation.control.mode === "bot" &&
        participant?.postEventFeedbackWhatsappOptIn === true,
    };
  }

  /**
   * At most one outbound per run, chosen deterministically rather than by the
   * model. Completion and safety are application decisions with their own copy;
   * only the ordinary case forwards the model's text.
   */
  private resolveOutbound(
    conversation: FeedbackConversationDocument,
    validated: ValidatedFeedbackExtraction,
    completing: boolean,
    cursorSeq: number,
    copy: PostEventFeedbackQuestionSetCopy,
  ): OutboundReply | undefined {
    if (!validated.reply && !completing && !isHandoff(validated)) {
      return undefined;
    }
    if (validated.replySuppressedReason === "not_permitted") {
      return undefined;
    }

    if (isHandoff(validated)) {
      return {
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
        dedupeKey: createFeedbackHandoffDedupeKey(conversation._id, cursorSeq),
      };
    }
    if (completing) {
      return {
        body: copy.closing,
        dedupeKey: createFeedbackClosingDedupeKey(conversation._id),
      };
    }
    return validated.reply
      ? {
          body: validated.reply,
          dedupeKey: createFeedbackReplyDedupeKey(conversation._id, cursorSeq),
        }
      : undefined;
  }

  /**
   * One PostgreSQL transaction per run, fenced by the conversation advisory
   * lock so two executions of the same job cannot interleave their inserts.
   */
  private async persist(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly campaign: FeedbackCampaignRow;
    readonly context: FeedbackExtractionContext;
    readonly validated: ValidatedFeedbackExtraction;
    readonly outbound: OutboundReply | undefined;
    readonly model: string;
    readonly correlationId: string;
  }): Promise<{
    answersWritten: number;
    notesWritten: number;
    outboxId?: string;
  }> {
    const candidateIds = input.context.candidates.map(
      (candidate) => candidate.participantId,
    );

    return this.database.transaction(async (transaction) => {
      await this.repository.lockConversation(
        transaction,
        input.conversation._id,
      );

      let answersWritten = 0;
      for (const answer of input.validated.answers) {
        const inserted = await this.repository.insertAnswerIfAbsent(
          transaction,
          {
            campaignId: input.campaign.id,
            conversationId: input.conversation._id,
            respondentParticipantId: input.conversation.respondentParticipantId,
            subjectParticipantId: answer.subjectParticipantId,
            questionKey: answer.questionKey,
            valueInt: answer.valueInt,
            sourceMessageIds: answer.sourceMessageIds,
            extractionMeta: buildExtractionMeta({
              model: input.model,
              confidence: answer.confidence,
              candidateIds,
            }),
          },
        );
        if (inserted) {
          answersWritten += 1;
        }
      }

      // `feedback_notes` has no natural unique key, so the run re-reads what is
      // already stored inside the same locked transaction. Together with the
      // cursor that is the note replay guard.
      const storedNotes = await this.repository.listNotesByConversation(
        input.conversation._id,
        transaction,
      );
      const storedNoteKeys = new Set(
        storedNotes.map((note) =>
          noteSignature(
            note.noteType,
            note.text,
            note.subjectParticipantId ?? null,
          ),
        ),
      );

      let notesWritten = 0;
      for (const note of input.validated.notes) {
        const signature = noteSignature(
          note.noteType,
          note.text,
          note.subjectParticipantId,
        );
        if (storedNoteKeys.has(signature)) {
          continue;
        }
        storedNoteKeys.add(signature);
        await this.repository.insertNote(transaction, {
          campaignId: input.campaign.id,
          conversationId: input.conversation._id,
          respondentParticipantId: input.conversation.respondentParticipantId,
          subjectParticipantId: note.subjectParticipantId,
          noteType: note.noteType,
          text: note.text,
          sourceMessageIds: note.sourceMessageIds,
          extractionMeta: buildExtractionMeta({
            model: input.model,
            confidence: note.confidence,
            candidateIds,
            flaggedForReview: note.flaggedForReview,
            unresolvedSubjectName: note.unresolvedSubjectName,
          }),
        });
        notesWritten += 1;
      }

      // D13: a safety signal is an audited human handoff, never an ordinary
      // note. The record says what was detected, not what was said.
      if (isHandoff(input.validated)) {
        await this.audit.append(transaction, {
          actorType: "system",
          actorId: "feedback_extraction",
          action: input.validated.safetySignal
            ? "feedback_conversation.safety_signalled"
            : "feedback_conversation.handoff_requested",
          entityType: "feedback_conversation",
          entityId: input.conversation._id,
          requestId: input.correlationId,
          context: {
            campaignId: input.conversation.campaignId,
            model: input.model,
            confidence: input.validated.confidence,
            safetySignal: input.validated.safetySignal,
            handoff: input.validated.handoff,
            suppressedNotes: input.validated.rejections.filter(
              (rejection) => rejection.reason === "safety_note_suppressed",
            ).length,
          },
        });
      }

      let outboxId: string | undefined;
      if (input.outbound) {
        const enqueued = await this.repository.insertOutboxIfAbsent(
          transaction,
          {
            conversationId: input.conversation._id,
            campaignId: input.campaign.id,
            kind: "reply",
            body: input.outbound.body,
            dedupeKey: input.outbound.dedupeKey,
          },
        );
        outboxId = enqueued.row.id;
      }

      return {
        answersWritten,
        notesWritten,
        ...(outboxId ? { outboxId } : {}),
      };
    });
  }

  /**
   * MongoDB last. Goals and attention are repaired forward on a replay; the
   * cursor advances only once every PostgreSQL effect is durable.
   */
  private async applyConversationState(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly validated: ValidatedFeedbackExtraction;
    readonly goalStatuses: readonly GoalStatusUpdate[];
    readonly completing: boolean;
    readonly cursorSeq: number;
    readonly model: string;
  }): Promise<void> {
    const at = new Date();

    if (input.goalStatuses.length > 0) {
      await this.conversations.updateGoalStatuses({
        conversationId: input.conversation._id,
        statuses: input.goalStatuses,
        at,
      });
    }

    if (isHandoff(input.validated)) {
      await this.conversations.setNeedsAttention({
        conversationId: input.conversation._id,
        needsAttention: true,
        at,
      });
    }

    await this.conversations.advanceCursor({
      conversationId: input.conversation._id,
      toSeq: input.cursorSeq,
      at,
      model: input.model,
    });

    if (input.completing) {
      await this.conversations.close({
        conversationId: input.conversation._id,
        reason: "completed",
        at,
      });
    }
  }

  private complete(
    result: ExtractFeedbackResult,
    correlationId: string,
  ): ExtractFeedbackResult {
    this.metrics.recordExtractOutcome(result.outcome, correlationId);
    return result;
  }
}

interface OutboundReply {
  readonly body: string;
  readonly dedupeKey: string;
}

interface GoalStatusUpdate {
  readonly key: FeedbackConversationGoal["key"];
  readonly status: FeedbackConversationGoal["status"];
}

/**
 * D12: every persisted row records the model, its confidence and the exact
 * candidate ids supplied to that run. Under live selection (D16) the candidate
 * set is the only way to explain later why a subject was — or was not —
 * resolvable at the time.
 */
function buildExtractionMeta(input: {
  readonly model: string;
  readonly confidence: number;
  readonly candidateIds: readonly string[];
  readonly flaggedForReview?: boolean;
  readonly unresolvedSubjectName?: string | null;
}): FeedbackExtractionMeta {
  return {
    model: input.model,
    confidence: input.confidence,
    candidateIds: [...input.candidateIds],
    ...(input.flaggedForReview ? { flaggedForReview: true } : {}),
    ...(input.unresolvedSubjectName
      ? { unresolvedSubjectName: input.unresolvedSubjectName }
      : {}),
  };
}

/**
 * Answered wins over everything, including a skip proposed in the same run.
 * Goals answered in an earlier run are re-derived rather than remembered, so a
 * replay that finds its answers already stored still repairs the statuses.
 */
function resolveGoalStatuses(
  goals: readonly FeedbackConversationGoal[],
  context: FeedbackExtractionContext,
  validated: ValidatedFeedbackExtraction,
): GoalStatusUpdate[] {
  const answered = new Set<string>([
    ...context.acceptedAnswers.map((answer) => answer.questionKey),
    ...validated.answers.map((answer) => answer.questionKey),
  ]);
  const updates = new Map<string, GoalStatusUpdate>();

  for (const goal of goals) {
    if (answered.has(goal.key)) {
      updates.set(goal.key, { key: goal.key, status: "answered" });
    }
  }
  for (const key of validated.skippedGoals) {
    if (!answered.has(key)) {
      updates.set(key, { key, status: "skipped" });
    }
  }
  // The next question is only "asked" once an outbound actually carries it.
  if (
    validated.nextGoal &&
    validated.reply &&
    !updates.has(validated.nextGoal)
  ) {
    updates.set(validated.nextGoal, {
      key: validated.nextGoal,
      status: "asked",
    });
  }

  return [...updates.values()];
}

function isCompleting(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): boolean {
  const byKey = new Map(updates.map((update) => [update.key, update.status]));
  return goals.every((goal) => {
    const status = byKey.get(goal.key) ?? goal.status;
    return status === "answered" || status === "skipped";
  });
}

function isHandoff(validated: ValidatedFeedbackExtraction): boolean {
  return validated.safetySignal || validated.handoff;
}

function noteSignature(
  noteType: string,
  text: string,
  subjectParticipantId: string | null,
): string {
  return `${noteType}::${subjectParticipantId ?? ""}::${text
    .trim()
    .replaceAll(/\s+/gu, " ")
    .toLowerCase()}`;
}

/**
 * The campaign's launch copy snapshot owns the wording, so a later copy edit
 * never rewrites a live questionnaire. The versioned constant is the fallback
 * when the snapshot is missing or malformed.
 */
export function resolveQuestionCopy(
  questions: Record<string, unknown> | undefined,
): PostEventFeedbackQuestionSetCopy {
  const snapshot = (questions as { copy?: Record<string, unknown> } | undefined)
    ?.copy;
  const resolved: PostEventFeedbackQuestionSetCopy = {
    ...POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
  };

  if (!snapshot) {
    return resolved;
  }
  for (const key of Object.keys(resolved) as (keyof typeof resolved)[]) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim().length > 0) {
      resolved[key] = value.trim();
    }
  }
  return resolved;
}
