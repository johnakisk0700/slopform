import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackAnswerQuestionKey,
  FeedbackCampaignRow,
  FeedbackExtractionMeta,
  FeedbackNoteType,
  MessageOutboxRow,
} from "@join-the-six/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "./feedback-operator-alert.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import type {
  FeedbackConversationDocument,
  FeedbackConversationGoal,
} from "../conversations/feedback-conversation.schemas.js";
import { EventsService } from "../events/events.service.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackExtractOutcome,
} from "./post-event-feedback-metrics.service.js";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  isPostEventFeedbackAnswerQuestionKey,
  type PostEventFeedbackQuestionSetCopy,
} from "./post-event-feedback-question-set.js";
import {
  validateFeedbackExtractionProposal,
  type FeedbackExtractionValidationResult,
} from "./post-event-feedback-extraction-validation.js";
import { PostEventFeedbackExtractionModel } from "./post-event-feedback-extraction.service.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "./post-event-feedback.schemas.js";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  createFeedbackClosingDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackReplyDedupeKey,
  type FeedbackExtractionContext,
  type ValidatedFeedbackExtraction,
  type ValidatedFeedbackSafetySignal,
} from "./post-event-feedback-extraction.schemas.js";
import {
  strongerRecommendedAction,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "./post-event-feedback-attention.js";
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
    // `resolveSkip` refuses to run under human control and the reminder sweep
    // refuses to nudge a flagged conversation.
    const urgentSafety = validated.safetySignals.some(
      (signal) => signal.recommendedAction === "urgent_human_follow_up",
    );
    const dutyOfCare = validated.handoff || urgentSafety;
    // Anchored on the participant's own latest message rather than on the
    // transcript length, because this run appends its reply to that same
    // transcript: a length-based key would differ on a replay that already sees
    // the reply, and a different `dedupe_key` is a second WhatsApp message.
    const outbound = this.resolveOutbound(
      conversation,
      validated,
      closingNow,
      urgentSafety,
      lastParticipantSeq(conversation) ?? cursorSeq,
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
    let spokeAt: number | undefined;
    for (const message of conversation.messages) {
      if (
        message.actor === "participant" &&
        (spokeAt === undefined || message.at.getTime() > spokeAt)
      ) {
        spokeAt = message.at.getTime();
      }
    }
    return (
      spokeAt !== undefined &&
      Date.now() - spokeAt < FEEDBACK_EXTRACT_QUIET_WINDOW_MS
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
      this.repository.listAnswersByConversation(conversation._id),
      this.repository.listNotesByConversation(conversation._id),
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
   * At most one outbound per run, chosen deterministically rather than by the
   * model. Completion and safety are application decisions with their own copy;
   * only the ordinary case forwards the model's text.
   *
   * `testimonySeq` is the last participant message's `seq` — the replay-stable
   * anchor for the dedupe key.
   *
   * `closingNow` is already the decision to send the closing copy — the caller
   * withholds it when this run produced safety signals, even if every goal is
   * terminal. Ranking completion above a disclosure thanked someone who had
   * just described being grabbed and closed the door on them.
   */
  private resolveOutbound(
    conversation: FeedbackConversationDocument,
    validated: FeedbackExtractionValidationResult,
    closingNow: boolean,
    urgentSafety: boolean,
    testimonySeq: number,
    copy: PostEventFeedbackQuestionSetCopy,
  ): OutboundReply | undefined {
    // Somebody has just said they do not want to live. There is no approved
    // copy for that, and every option the questionnaire owns is wrong: the next
    // question treats it as a lull in conversation, and the thank-you treats it
    // as an ending. Until a policy defines a safe reply, the bot says nothing
    // and the conversation goes to a person. An explicit handoff is the one
    // exception, because its copy says exactly that.
    if (urgentSafety && !validated.handoff) {
      return undefined;
    }
    if (!validated.reply && !closingNow && !validated.handoff) {
      return undefined;
    }
    if (validated.replySuppressedReason === "not_permitted") {
      return undefined;
    }

    // Only an *explicit* handoff swaps the copy. A safety signal no longer does
    // (D13, amended): forcing the neutral "someone will contact you" line ended
    // the questionnaire on the model's say-so, and the participant who had just
    // disclosed something got the most abrupt possible reply. Attention is
    // raised instead, and the conversation continues normally.
    if (validated.handoff) {
      return {
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
        dedupeKey: createFeedbackHandoffDedupeKey(
          conversation._id,
          testimonySeq,
        ),
      };
    }
    if (closingNow) {
      return {
        body: copy.closing,
        dedupeKey: createFeedbackClosingDedupeKey(conversation._id),
      };
    }
    // The model wrote its reply believing its own proposal was accepted. When
    // validation then refused the answer, «Τέλεια, το σημείωσα!» is a straight
    // untruth: nothing was recorded, the participant believes the question is
    // behind them, and the score is lost with nobody aware. Ask the question
    // again instead — in the campaign's own words, which are the only ones here
    // guaranteed to still be true.
    const refused = refusedAnswerQuestionKey(validated);
    if (refused) {
      return {
        body: copy[refused],
        dedupeKey: createFeedbackReplyDedupeKey(conversation._id, testimonySeq),
      };
    }

    return validated.reply
      ? {
          body: validated.reply,
          dedupeKey: createFeedbackReplyDedupeKey(
            conversation._id,
            testimonySeq,
          ),
        }
      : undefined;
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
      await this.repository.lockConversation(
        transaction,
        input.conversation._id,
      );

      let answersWritten = 0;
      for (const answer of input.validated.answers) {
        // «άκυρο, τον Κώστα Π. καλύτερα όχι ξανά» moves a person, it does not
        // add a second opinion about them. Clearing the questions this one
        // contradicts is what makes the move a move.
        if (answer.subjectParticipantId) {
          await this.repository.deleteContradictedAnswers(transaction, {
            conversationId: input.conversation._id,
            subjectParticipantId: answer.subjectParticipantId,
            questionKeys: contradictedQuestionKeys(answer.questionKey),
          });
        }
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

/**
 * Anything that should surface in the admin inbox. Safety and handoff are the
 * incident path (D13); a flagged subjectless note (D18) and a refused answer
 * revision are quieter — the safeguard already wrote the note or kept the
 * stored value, and without the flag nobody would know to look.
 */
function needsOperatorAttention(
  validated: FeedbackExtractionValidationResult,
): boolean {
  return (
    isSafetyOrHandoffAttention(validated) ||
    validated.notes.some((note) => note.flaggedForReview) ||
    validated.conflictingAnswerRevision
  );
}

function isSafetyOrHandoffAttention(
  validated: ValidatedFeedbackExtraction,
): boolean {
  return validated.safetySignals.length > 0 || validated.handoff;
}

interface GroupedMessageAttention {
  readonly messageId: string;
  readonly categories: readonly PostEventFeedbackSafetyCategory[];
  readonly recommendedAction: PostEventFeedbackRecommendedAction;
  readonly confidence: number;
}

function groupSafetySignalsByMessage(
  signals: readonly ValidatedFeedbackSafetySignal[],
): GroupedMessageAttention[] {
  const grouped = new Map<
    string,
    {
      categories: Set<PostEventFeedbackSafetyCategory>;
      recommendedAction: PostEventFeedbackRecommendedAction;
      confidence: number;
    }
  >();

  for (const signal of signals) {
    for (const messageId of signal.sourceMessageIds) {
      const current = grouped.get(messageId);
      if (current) {
        current.categories.add(signal.category);
        current.recommendedAction = strongerRecommendedAction(
          current.recommendedAction,
          signal.recommendedAction,
        );
        current.confidence = Math.max(current.confidence, signal.confidence);
      } else {
        grouped.set(messageId, {
          categories: new Set([signal.category]),
          recommendedAction: signal.recommendedAction,
          confidence: signal.confidence,
        });
      }
    }
  }

  return [...grouped.entries()].map(([messageId, attention]) => ({
    messageId,
    categories: [...attention.categories],
    recommendedAction: attention.recommendedAction,
    confidence: attention.confidence,
  }));
}

/**
 * The transcript position the run is answering. Stable across replays because
 * only the participant can move it — the bot reply this run appends cannot.
 */
function lastParticipantSeq(
  conversation: FeedbackConversationDocument,
): number | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.actor === "participant") {
      return message.seq;
    }
  }
  return undefined;
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

/**
 * The question whose answer this run refused for being unusable, if any.
 *
 * Only refusals the participant can act on count. An `already_recorded`
 * duplicate or an unresolvable name needs no second attempt from them, while an
 * out-of-range score or a missing subject does — and re-asking is the only way
 * they ever find out we did not take it.
 */
function refusedAnswerQuestionKey(
  validated: FeedbackExtractionValidationResult,
): FeedbackAnswerQuestionKey | undefined {
  const actionable = validated.rejections.find(
    (rejection) =>
      rejection.scope === "answer" &&
      (rejection.reason === "invalid_score" ||
        rejection.reason === "missing_subject"),
  );
  const key = actionable?.questionKey;
  return key && isPostEventFeedbackAnswerQuestionKey(key)
    ? (key as FeedbackAnswerQuestionKey)
    : undefined;
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
