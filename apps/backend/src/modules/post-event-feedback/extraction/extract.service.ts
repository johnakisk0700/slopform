import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackAnswerQuestionKey,
  FeedbackCampaignRow,
  FeedbackExtractionMeta,
  FeedbackNoteType,
  MessageOutboxRow,
} from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../feedback-operator-alert.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "../../conversations/feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../../conversations/feedback-conversation.schemas.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  isCompleting,
  resolveGoalStatuses,
  type GoalStatusUpdate,
} from "./goal-progress.js";
import {
  groupSafetySignalsByMessage,
  isSafetyOrHandoffAttention,
  needsOperatorAttention,
} from "./operator-attention.js";
import { resolveOutbound, type OutboundReply } from "./outbound-reply.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackExtractOutcome,
} from "../post-event-feedback-metrics.service.js";
import {
  noteSignature,
  resolveCampaignCopy,
} from "../post-event-feedback-question-set.js";
import {
  validateFeedbackExtractionProposal,
  type FeedbackExtractionValidationResult,
} from "./validate-proposal.js";
import { PostEventFeedbackExtractionModel } from "./model.service.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "../post-event-feedback.schemas.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import {
  buildFeedbackExtractionPrompt,
  estimatePromptTokens,
} from "./prompt.js";

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
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly audit: AuditRepository,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    @Inject(FEEDBACK_OPERATOR_ALERT)
    private readonly alert: FeedbackOperatorAlert,
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
    const skipped = this.skipOutcome(conversation, cursorSeq);
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

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      throw new PostEventFeedbackCampaignNotFoundError(conversation.campaignId);
    }

    const context = await this.buildContext(conversation, campaign);
    const copy = resolveCampaignCopy(campaign.questions);
    const prompt = buildFeedbackExtractionPrompt({ context, copy });
    const estimatedPromptTokens = estimatePromptTokens(prompt);

    const [generated, attention] = await Promise.all([
      this.generation.propose(prompt),
      this.generation.classifyAttention(
        context.messages,
        context.newParticipantMessageIds,
      ),
    ]);
    this.metrics.recordExtractTokens(
      {
        phase: "feedback_extraction",
        model: generated.model,
        estimatedPromptTokens,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        totalTokens: generated.usage.totalTokens,
      },
      input.correlationId,
    );
    this.metrics.recordExtractTokens(
      {
        phase: "attention_classification",
        model: attention.model,
        estimatedPromptTokens: attention.estimatedPromptTokens,
        inputTokens: attention.usage.inputTokens,
        outputTokens: attention.usage.outputTokens,
        totalTokens: attention.usage.totalTokens,
      },
      input.correlationId,
    );

    const validated = validateFeedbackExtractionProposal(
      generated.proposal,
      context,
      attention.signals,
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
    // A disclosure that happens to finish the questionnaire is not a finish
    // line: closing copy and close() wait for a run that did not raise safety.
    // Results, attention and the alert still write; only the conversational
    // ending is deferred so a human can take the thread.
    const closingNow = completing && validated.safetySignals.length === 0;
    // The two signals that end the questionnaire outright, as opposed to
    // flagging it. Both mean the same thing — from here a person is answering,
    // not the bot — so both hand control over, which is the existing brake:
    // `skipOutcome` refuses to run under human control and the reminder sweep
    // refuses to nudge a flagged conversation.
    const urgentSafety = validated.safetySignals.some(
      (signal) => signal.recommendedAction === "urgent_human_follow_up",
    );
    const dutyOfCare = validated.handoff || urgentSafety;
    // Anchored on the participant's own latest message rather than on the
    // transcript length, because this run appends its reply to that same
    // transcript: a length-based key would differ on a replay that already sees
    // the reply, and a different `dedupe_key` is a second WhatsApp message.
    const outbound = resolveOutbound(
      conversation,
      validated,
      closingNow,
      urgentSafety,
      latestParticipantMessage(conversation)?.seq ?? cursorSeq,
      copy,
    );
    const withheld = outbound
      ? await this.reviewBeforeSending({
          conversation,
          cursorSeq,
          // Only an ordinary conversational reply may be dropped for being
          // superseded. Completion and handoff are application commitments with
          // their own copy: the first closes the conversation, after which no
          // later run can speak at all, and the second promises a human.
          // Swallowing either leaves the participant waiting for a message that
          // is never coming.
          ordinaryReply: !closingNow && !validated.handoff,
        })
      : undefined;
    if (withheld) {
      this.logger.log({
        event: "feedback.extract.outbound_withheld",
        correlationId: input.correlationId,
        conversationId: conversation._id,
        cursorSeq,
        reason: withheld,
      });
    }

    const written = await this.persist({
      conversation,
      campaign,
      context,
      validated,
      outbound: withheld ? undefined : outbound,
      model: generated.model,
      correlationId: input.correlationId,
    });

    // Between the PostgreSQL commit and the cursor advance, so a crash replays
    // the whole run and repairs the transcript through the same `outboxId`. The
    // stored row's body is used rather than `outbound.body`: a replay may
    // produce different reply text while `insertOutboxIfAbsent` returns the
    // row that was actually enqueued and will actually be sent.
    if (written.outbox) {
      await this.outboundTranscript.record(
        written.outbox,
        new Date(),
        input.correlationId,
      );
    }

    await this.applyConversationState({
      conversation,
      validated,
      goalStatuses,
      closingNow,
      dutyOfCare,
      cursorSeq,
      model: generated.model,
      correlationId: input.correlationId,
    });

    return this.complete(
      {
        // A safety signal is no longer an outcome of its own: the run extracted
        // normally and the flag is what an operator acts on. Only an explicit
        // handoff changes what the conversation did. Closing is deferred when
        // this run produced safety signals even if every goal is terminal.
        outcome: closingNow
          ? "completed"
          : validated.handoff
            ? "handoff"
            : "extracted",
        conversationId: conversation._id,
        cursorSeq,
        answersWritten: written.answersWritten,
        notesWritten: written.notesWritten,
        ...(written.outbox ? { outboxId: written.outbox.id } : {}),
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
  private skipOutcome(
    conversation: FeedbackConversationDocument,
    latestSeq: number,
  ): FeedbackExtractOutcome | undefined {
    if (conversation.lifecycle.state === "closed") {
      return "skipped_closed";
    }
    if (conversation.control.mode === "human") {
      return "skipped_human_control";
    }
    // Control is still `bot`, and the bot has still stopped talking: it has
    // promised a person, or read something it must not answer. The questionnaire
    // used to resume here on the very next message.
    if (conversation.awaitingHuman) {
      return "skipped_awaiting_human";
    }
    if (conversation.extraction.cursorSeq >= latestSeq) {
      return "skipped_cursor";
    }
    if (this.stillTyping(conversation)) {
      return "skipped_still_typing";
    }
    return undefined;
  }

  /**
   * The burst is not over yet, so this run stands down for the one behind it.
   *
   * The quiet window is leading-edge: the *first* message of a burst starts a
   * clock, and every message after it starts another. Somebody typing a
   * fragment every twenty-five seconds therefore had a run come due while they
   * were still mid-thought, and got a reply per fragment — the exact behaviour
   * the window was added to stop, just moved along by one gap.
   *
   * Deferring here converts the fixed window into a real settle: a run only
   * proceeds once nothing new has arrived for a full window. It costs nothing,
   * because the message that made this run early has already queued a run of
   * its own, further out, and that one reads everything this one would have.
   *
   * Liveness comes from the same fact. The newest message's own run comes due
   * exactly one window after it arrived, so its check reads `>=` and always
   * proceeds; only runs with something newer behind them ever defer. The cursor
   * is deliberately left where it was — a deferred run reads nothing, so it has
   * no window to close.
   */
  private stillTyping(conversation: FeedbackConversationDocument): boolean {
    const spokeAt = latestParticipantMessage(conversation)?.at;
    return (
      spokeAt !== undefined &&
      Date.now() - spokeAt.getTime() < FEEDBACK_EXTRACT_QUIET_WINDOW_MS
    );
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
      this.results.listAnswersByConversation(conversation._id),
      this.results.listNotesByConversation(conversation._id),
      this.participants.findById(conversation.respondentParticipantId),
    ]);

    return {
      respondentParticipantId: conversation.respondentParticipantId,
      respondentDisplayName: participant?.preferredName?.trim() || null,
      candidates: candidates.items,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        seq: message.seq,
        actor: message.actor,
        occurredAt: message.at.toISOString(),
        text: message.text,
      })),
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
      })),
      acceptedNotes: acceptedNotes.map((note) => ({
        noteType: note.noteType as FeedbackNoteType,
        text: note.text,
        subjectParticipantId: note.subjectParticipantId,
      })),
      // AI output can never send, change consent or bypass this gate. A paused
      // or closed campaign is the kill switch: results may still persist, but
      // no reply is enqueued.
      replyAllowed:
        conversation.lifecycle.state === "open" &&
        conversation.control.mode === "bot" &&
        participant?.postEventFeedbackWhatsappOptIn === true &&
        campaign.status === "launched",
    };
  }

  /**
   * The last look before anything reaches a phone. Returns why the outbound was
   * withheld, or `undefined` to send it.
   *
   * Everything the run decided with was snapshotted before the provider call,
   * and that call takes seconds — long enough for staff to take the
   * conversation over, close it, or for the participant to withdraw consent.
   * The snapshot cannot see any of that, which is what made these three races
   * real: the guards at the top of the run were correct and simply too early.
   *
   * The first three reasons silence **every** kind of outbound, closing copy and
   * handoff included. A thank-you sent into a conversation a colleague has taken
   * over, or a promise of a human sent to somebody who just asked us to stop
   * writing, is worse than saying nothing. Only the last reason — the
   * participant kept typing while the model was thinking — is limited to an
   * ordinary reply, because there the conversation is healthy and merely has a
   * newer thought for the next run to answer.
   *
   * Only the outbound is ever dropped. Answers, notes and the cursor are written
   * exactly as they would have been, which is what keeps this safe under
   * retries: the rule that every run closes the window it opened stays intact.
   * Every reason is a database read rather than a model judgement, so a replay
   * of the same job reaches the same conclusion instead of a fresh opinion.
   */
  private async reviewBeforeSending(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly cursorSeq: number;
    readonly ordinaryReply: boolean;
  }): Promise<string | undefined> {
    const current = await this.conversations.findById(input.conversation._id);
    if (!current) {
      return "conversation_missing";
    }
    if (current.lifecycle.state !== "open") {
      return "conversation_closed";
    }
    if (current.control.mode !== "bot") {
      return "human_control";
    }

    const participant = await this.participants.findById(
      input.conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return "consent_withdrawn";
    }

    if (
      input.ordinaryReply &&
      current.messages.some(
        (message) =>
          message.actor === "participant" && message.seq > input.cursorSeq,
      )
    ) {
      return "superseded_by_newer_testimony";
    }
    return undefined;
  }

  /**
   * One PostgreSQL transaction per run, fenced by the conversation advisory
   * lock so two executions of the same job cannot interleave their inserts.
   */
  private async persist(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly campaign: FeedbackCampaignRow;
    readonly context: FeedbackExtractionContext;
    readonly validated: FeedbackExtractionValidationResult;
    readonly outbound: OutboundReply | undefined;
    readonly model: string;
    readonly correlationId: string;
  }): Promise<{
    answersWritten: number;
    notesWritten: number;
    outbox?: MessageOutboxRow;
  }> {
    const candidateIds = input.context.candidates.map(
      (candidate) => candidate.participantId,
    );

    return this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, input.conversation._id);

      let answersWritten = 0;
      for (const answer of input.validated.answers) {
        // «άκυρο, τον Κώστα Π. καλύτερα όχι ξανά» moves a person, it does not
        // add a second opinion about them. Clearing the questions this one
        // contradicts is what makes the move a move.
        if (answer.subjectParticipantId) {
          await this.results.deleteContradictedAnswers(transaction, {
            conversationId: input.conversation._id,
            subjectParticipantId: answer.subjectParticipantId,
            questionKeys: contradictedQuestionKeys(answer.questionKey),
          });
        }
        const inserted = await this.results.insertAnswerIfAbsent(transaction, {
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
        });
        if (inserted) {
          answersWritten += 1;
        }
      }

      // `feedback_notes` has no natural unique key, so the run re-reads what is
      // already stored inside the same locked transaction. Together with the
      // cursor that is the note replay guard.
      const storedNotes = await this.results.listNotesByConversation(
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
        await this.results.insertNote(transaction, {
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

      // D13 (amended): the audit records that a human should look, not what was
      // said — the notes above already hold the participant's own words, in the
      // ordinary place an operator reads them. Flagged-note and revision
      // attention are quieter: they raise the durable flag without an incident
      // audit of their own.
      if (isSafetyOrHandoffAttention(input.validated)) {
        await this.audit.append(transaction, {
          actorType: "system",
          actorId: "feedback_extraction",
          action:
            input.validated.safetySignals.length > 0
              ? "feedback_conversation.safety_signalled"
              : "feedback_conversation.handoff_requested",
          entityType: "feedback_conversation",
          entityId: input.conversation._id,
          requestId: input.correlationId,
          context: {
            campaignId: input.conversation.campaignId,
            model: input.model,
            confidence: input.validated.confidence,
            safetySignal: input.validated.safetySignals.length > 0,
            safetySignals: input.validated.safetySignals.map((signal) => ({
              category: signal.category,
              recommendedAction: signal.recommendedAction,
              sourceMessageIds: [...signal.sourceMessageIds],
              confidence: signal.confidence,
            })),
            handoff: input.validated.handoff,
          },
        });
      }

      let outbox: MessageOutboxRow | undefined;
      if (input.outbound) {
        const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
          conversationId: input.conversation._id,
          campaignId: input.campaign.id,
          kind: "reply",
          body: input.outbound.body,
          dedupeKey: input.outbound.dedupeKey,
        });
        outbox = enqueued.row;
      }

      return {
        answersWritten,
        notesWritten,
        ...(outbox ? { outbox } : {}),
      };
    });
  }

  /**
   * MongoDB last. Goals and attention are repaired forward on a replay; the
   * cursor advances only once every PostgreSQL effect is durable.
   */
  private async applyConversationState(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly validated: FeedbackExtractionValidationResult;
    readonly goalStatuses: readonly GoalStatusUpdate[];
    readonly closingNow: boolean;
    readonly dutyOfCare: boolean;
    readonly cursorSeq: number;
    readonly model: string;
    readonly correlationId: string;
  }): Promise<void> {
    const at = new Date();

    if (input.goalStatuses.length > 0) {
      await this.conversations.updateGoalStatuses({
        conversationId: input.conversation._id,
        statuses: input.goalStatuses,
        at,
      });
    }

    for (const attention of groupSafetySignalsByMessage(
      input.validated.safetySignals,
    )) {
      await this.conversations.mergeMessageAttention({
        conversationId: input.conversation._id,
        messageId: attention.messageId,
        categories: attention.categories,
        recommendedAction: attention.recommendedAction,
        confidence: attention.confidence,
        at,
      });
    }

    if (needsOperatorAttention(input.validated)) {
      const attention = await this.conversations.setNeedsAttention({
        conversationId: input.conversation._id,
        needsAttention: true,
        at,
      });
      // Only the false → true crossing notifies, and only for safety or an
      // explicit handoff. A flagged subjectless note or a refused revision is
      // routine operator work — durable in the inbox, not a page-worthy alert.
      // A replayed run re-asserts the same flag, gets `changed: false` and
      // stays quiet either way.
      if (attention.changed && isSafetyOrHandoffAttention(input.validated)) {
        await this.alert.raise({
          conversationId: input.conversation._id,
          campaignId: input.conversation.campaignId,
          reason: "extraction_safety_signal",
          correlationId: input.correlationId,
          detail: [
            ...input.validated.safetySignals.map(
              (signal) => `${signal.category}:${signal.recommendedAction}`,
            ),
            ...(input.validated.handoff ? ["handoff"] : []),
          ],
        });
      }
    }

    await this.conversations.advanceCursor({
      conversationId: input.conversation._id,
      toSeq: input.cursorSeq,
      at,
      model: input.model,
    });

    // After the cursor, so this run's window is closed before the bot goes
    // quiet — a cursor left behind would strand the testimony this run read.
    //
    // Not `takeOver`: D17 is explicit that a handoff is a promise and control
    // moves when a person presses the button. This is the state between those
    // two moments, which the conversation had no way to represent — so the bot
    // promised a human and then asked about the dinner again on the next
    // message. The conversation stays open and under bot control; the bot
    // simply stops speaking until somebody arrives.
    if (input.dutyOfCare) {
      await this.conversations.markAwaitingHuman({
        conversationId: input.conversation._id,
        at,
      });
    }

    if (input.closingNow) {
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
 * Questions that cannot both be true about the same person at the same time.
 *
 * «Θα τον ξαναέβλεπα» and «καλύτερα όχι ξανά» are the same decision with
 * opposite answers, so recording one has to clear the other. `liked` counts as
 * incompatible with `avoid` for the same reason a participant does: somebody
 * they now want to steer clear of is not somebody who made a good impression.
 * Nothing else conflicts — a score says nothing about a person, and liking
 * somebody and wanting to see them again agree.
 */
function contradictedQuestionKeys(
  questionKey: FeedbackAnswerQuestionKey,
): readonly FeedbackAnswerQuestionKey[] {
  if (questionKey === "avoid") {
    return ["liked", "meet_again"];
  }
  if (questionKey === "liked" || questionKey === "meet_again") {
    return ["avoid"];
  }
  return [];
}
