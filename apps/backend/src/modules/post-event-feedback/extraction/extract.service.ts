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
import { isCorrectedAnswer } from "./answer-corrections.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  isCompleting,
  isWithdrawal,
  nextOpenGoal,
  resolveGoalStatuses,
  withAskedGoal,
  withSettledOpenGoals,
  type GoalStatusUpdate,
} from "./goal-progress.js";
import {
  countsAsHostileTurn,
  groupSafetySignalsByMessage,
  isSafetyOrHandoffAttention,
  operatorAttentionRaises,
  respondentSourceMessageIds,
  stopsForHostility,
  type FeedbackHostilityRaise,
} from "./operator-attention.js";
import {
  answeredAnything,
  resolveOutbound,
  withSafetyAssurance,
  type OutboundReply,
} from "./outbound-reply.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackExtractOutcome,
} from "../metrics.service.js";
import { noteSignature, resolveCampaignCopy } from "../question-set.js";
import {
  validateFeedbackExtractionProposal,
  type FeedbackExtractionValidationResult,
} from "./validate-proposal.js";
import {
  FeedbackExtractionGenerationError,
  PostEventFeedbackExtractionModel,
} from "./model.service.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "../jobs.schemas.js";
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

    // Every other rejection costs one row and lets the rest of the run stand.
    // This one condemns the whole run, because there is nothing left of it worth
    // keeping: the model asked for a human instead of reading a message that
    // still held an answer, and obeying that would freeze the questionnaire on
    // `awaitingHuman`, queue an operator, and advance the cursor past the
    // testimony — which is how Μαρία Φλερτατζού's «βαζω 5. ο Τάσος ήτανε πολύ
    // ωραίος…» was lost twice in one night.
    //
    // Failing here is what buys the retry, and the retry is the only thing that
    // can still read her answers; a run that continued with `handoff: false`
    // would close the window on testimony nobody extracted. Retryable and
    // `validation_failed` for the same reason a malformed object is: the fault is
    // this generation, another attempt may not repeat it, and if every attempt
    // does then BullMQ's last one lands in the deterministic fallback, which
    // files a note and flags the conversation for a person.
    if (
      validated.rejections.some(
        (rejection) => rejection.reason === "handoff_discards_testimony",
      )
    ) {
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }

    // Statuses from what validation accepted — never from the model's nextGoal.
    // `asked` is applied after resolveOutbound, from the question the outbound
    // actually carries, so a replaced reply cannot advance the ladder past a
    // refusal.
    const recordedStatuses = resolveGoalStatuses(
      conversation.goals,
      context,
      validated,
    );
    const openGoal = nextOpenGoal(conversation.goals, recordedStatuses);
    // Closing copy is only earned by answers/skips that already finished the
    // ladder. A withdrawal settles open goals *after* the outbound is chosen,
    // so the participant still gets the model's goodbye rather than the
    // campaign thank-you — then `closingNow` below closes on the settled state.
    const progressClosing =
      isCompleting(conversation.goals, recordedStatuses) &&
      validated.safetySignals.length === 0;
    // The two signals that end the questionnaire outright, as opposed to
    // flagging it. Both mean the same thing — from here a person is answering,
    // not the bot — so both hand control over, which is the existing brake:
    // `skipOutcome` refuses to run under human control and the reminder sweep
    // refuses to nudge a flagged conversation.
    const urgentSafety = validated.safetySignals.some(
      (signal) => signal.recommendedAction === "urgent_human_follow_up",
    );
    const dutyOfCare = validated.handoff || urgentSafety;
    // The hostility ladder, decided from the stored count plus this run rather
    // than from a re-read of the document.
    //
    // Deriving it here — before anything is written — is what makes a replay
    // agree with the original: the cursor has not moved, so a replayed run reads
    // the same snapshot, classifies the same messages, computes the same rung and
    // resolves the same dedupe key. Reading the counter back after incrementing
    // it would make the decision depend on how many times the job had already
    // run, which is exactly the fact a replay must not be able to observe.
    const hostileTurn = countsAsHostileTurn({
      hostileMessageIds: attention.hostileMessageIds,
      safetySignalCount: validated.safetySignals.length,
    });
    const hostileTurns = conversation.hostileTurns + (hostileTurn ? 1 : 0);
    const stoppingForHostility = stopsForHostility({
      hostileTurn,
      hostileTurns,
      safetySignalCount: validated.safetySignals.length,
    });
    // Anchored on the participant's own latest message rather than on the
    // transcript length, because this run appends its reply to that same
    // transcript: a length-based key would differ on a replay that already sees
    // the reply, and a different `dedupe_key` is a second WhatsApp message.
    const outbound = withSafetyAssurance(
      conversation,
      validated,
      resolveOutbound(
        conversation,
        validated,
        progressClosing,
        urgentSafety,
        latestParticipantMessage(conversation)?.seq ?? cursorSeq,
        copy,
        openGoal,
        stoppingForHostility,
      ),
      new Set(attention.describedIncidentMessageIds),
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
          //
          // The hostility exit line is the third such commitment, and the worst
          // one to lose: `awaitingHuman` silences every run after this, so a line
          // dropped for being superseded would leave somebody abusive answered by
          // nothing at all and no explanation of why the bot went quiet.
          ordinaryReply:
            !progressClosing && !validated.handoff && !stoppingForHostility,
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
    // Asked and withdrawal both key off what will actually reach the phone.
    // Marking liked asked — or settling the ladder — for a reply that was
    // withheld is the same class of lie as attaching askedGoal to a statement.
    const sentOutbound = withheld ? undefined : outbound;
    let goalStatuses = withAskedGoal(recordedStatuses, sentOutbound?.askedGoal);
    // Prompt rule 7δ already tells the model to decline every open goal when
    // it withdraws; this is the net when it writes the goodbye, still names a
    // nextGoal, and forgets the declines. A nextGoal-null statement is a
    // side-question answer and must not settle. Safety and handoff keep the
    // ladder open for a human — closing on a disclosure that produced no
    // structured rows would slam the door.
    // Not a withdrawal, even though it looks exactly like one from here: the bot
    // did not run out of things it was willing to say, it decided to stop. The
    // difference matters downstream — a withdrawal settles every open goal as
    // skipped, which would record this person as having declined a questionnaire
    // nobody managed to ask him, and it raises `unfinished_questionnaire` instead
    // of the reason that says what actually happened.
    const withdrew =
      !dutyOfCare &&
      !stoppingForHostility &&
      validated.safetySignals.length === 0 &&
      isWithdrawal({
        answers: validated.answers,
        notes: validated.notes,
        nextGoal: validated.nextGoal,
        askedGoal: sentOutbound?.askedGoal,
        outboundSent: sentOutbound !== undefined,
        repairingStoredResults: validated.rejections.some(
          (rejection) => rejection.reason === "already_recorded",
        ),
      });
    if (withdrew) {
      goalStatuses = withSettledOpenGoals(conversation.goals, goalStatuses);
    }
    // A disclosure that happens to finish the questionnaire is not a finish
    // line: closing copy and close() wait for a run that did not raise safety.
    // Results, attention and the alert still write; only the conversational
    // ending is deferred so a human can take the thread.
    //
    // Neither is a withdrawal a finish line. Μπάμπης Διπλογαμωσταυρίδης swore
    // at the bot, the bot bowed out, every goal settled — and the conversation
    // closed as `completed`, so his next message was answered with «Τέλεια,
    // ευχαριστούμε πολύ! 🙌». A participant who explicitly declines every
    // question is finished; a bot that gave up on one is not, and a person
    // should look at it. The ladder stops either way, which is what the settled
    // goals are for.
    //
    // The handoff is the third: `awaitingHuman` says the bot is waiting for a
    // person, and closing the thread underneath that promise is how «σβήστε
    // ό,τι σας είπα» was answered with a human's name and then filed as done.
    //
    // And the fourth is the one this feature closes. A hostile turn where nothing
    // was ever answered must not close as `completed`, because that is the word
    // for a questionnaire somebody finished. Μπάμπης answered nothing; a model
    // that declines his four open goals on «άντε γαμήσου» has not been told the
    // questionnaire is over, it has tidied up after somebody who never started
    // it, and `completed` then records a finished questionnaire that never
    // happened — in the same column the campaign's response rate is read from.
    //
    // `answeredAnything` is the line, not hostility on its own: somebody who
    // gives us a score and two names and then swears has genuinely completed the
    // thing, and there is no reason to withhold the word from that.
    const hostileWithoutAnswers =
      hostileTurn && !answeredAnything(conversation, validated);
    const hostility: FeedbackHostilityRaise = stoppingForHostility
      ? "stopped"
      : hostileWithoutAnswers && isCompleting(conversation.goals, goalStatuses)
        ? "unanswerable"
        : "none";
    const closingNow =
      isCompleting(conversation.goals, goalStatuses) &&
      validated.safetySignals.length === 0 &&
      !dutyOfCare &&
      !withdrew &&
      !stoppingForHostility &&
      !hostileWithoutAnswers;

    const written = await this.persist({
      conversation,
      campaign,
      context,
      validated,
      outbound: sentOutbound,
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
      withdrew,
      hostility,
      hostileTurn,
      priorHostileTurns: conversation.hostileTurns,
      newestParticipantMessageId:
        context.newParticipantMessageIds.at(-1) ?? null,
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
        correctedByOperator: isCorrectedAnswer(answer.extractionMeta),
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
    // An `avoid` given for an abusive reason is still recorded — deciding for
    // somebody with no trace that we did is worse — but it is a statement, not
    // an instruction, and it must never reach a seating decision. The hold rides
    // on the row from the moment it is written, because this run is the only
    // place that has both the answer and the classification of the message it
    // cites in hand.
    const heldMessageIds = respondentSourceMessageIds(
      input.validated.safetySignals,
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
          matchingHold: answer.sourceMessageIds.some((messageId) =>
            heldMessageIds.has(messageId),
          ),
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
    readonly withdrew: boolean;
    readonly hostility: FeedbackHostilityRaise;
    /** Whether this run advances the hostility ladder by one rung. */
    readonly hostileTurn: boolean;
    /** The count this run decided from — the compare-and-set's expected value. */
    readonly priorHostileTurns: number;
    /** The anchor for a reason this run raised that cites no message itself. */
    readonly newestParticipantMessageId: string | null;
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

    // Before the raise and before the cursor: the ladder is what the next run
    // reads to decide whether it may still speak, so a crash between here and the
    // cursor advance has to leave the rung spent rather than free. The
    // compare-and-set is what stops the replay of that same run spending a second
    // one.
    if (input.hostileTurn) {
      await this.conversations.recordHostileTurn({
        conversationId: input.conversation._id,
        at,
        expectedCount: input.priorHostileTurns,
      });
    }

    const raises = operatorAttentionRaises(
      input.validated,
      input.newestParticipantMessageId,
      input.withdrew,
      input.hostility,
    );
    let raisedIncident = false;
    for (const raise of raises) {
      const attention = await this.conversations.raiseAttention({
        conversationId: input.conversation._id,
        kind: raise.kind,
        messageId: raise.messageId,
        at,
      });
      // The badge is raised with the reason or not at all: a bare flag is what
      // reached the inbox saying nothing an operator could read or dismiss.
      raisedIncident ||=
        attention.changed &&
        (raise.kind === "safety" || raise.kind === "handoff");
    }

    // Only a newly recorded safety or handoff reason notifies. A flagged
    // subjectless note or a refused revision is routine operator work — durable
    // in the inbox, not a page-worthy alert. A replayed run re-raises the same
    // kind against the same message, gets `changed: false` from the idempotent
    // write and stays quiet.
    if (raisedIncident) {
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
    //
    // A withdrawal lands in the same state for a different reason: the bot did
    // not promise anybody, it ran out of things it was willing to say. Leaving
    // it under bot control with the ladder settled and nothing flagged means
    // nobody ever looks — the conversation just goes quiet with no answers in
    // it. Waiting for a person is the honest description of where it is.
    //
    // The hostility stop is the third, and it is the only one of the three the
    // participant was not promised anything by. That is the point: he never asked
    // us to stop and we are not pretending he did, so the conversation stays open
    // and his consent stays exactly as he left it — but the bot has said its last
    // line, and `awaitingHuman` is what makes that true of the next message
    // instead of only of this one. `unanswerable` deliberately does **not** land
    // here: the ladder still has rungs left, so the bot keeps its voice and only
    // the badge goes up.
    if (input.dutyOfCare || input.withdrew || input.hostility === "stopped") {
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
