import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackAnswerQuestionKey,
  FeedbackCampaignRow,
  FeedbackExtractionMeta,
  FeedbackNoteType,
  MessageOutboxRow,
  MessageOutboxStatus,
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
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  isCompleting,
  isWithdrawal,
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
  withCampaignReaskCap,
  withPolicyAnswers,
  withSafetyAssurance,
  type OutboundReply,
} from "./outbound-reply.js";
import { isUnansweredPolicyQuestion } from "./policy-answers.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackExtractOutcome,
} from "../metrics.service.js";
import {
  contradictedPostEventFeedbackQuestionKeys,
  noteSignature,
  resolveCampaignCopy,
} from "../question-set.js";
import {
  validateFeedbackExtractionProposal,
  type FeedbackExtractionValidationResult,
} from "./validate-proposal.js";
import {
  FeedbackExtractionGenerationError,
  FeedbackProviderCallGuardError,
  PostEventFeedbackExtractionModel,
  combineFeedbackExtractionUsage,
  type FeedbackExtractionUsage,
} from "./model.service.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "../jobs.schemas.js";
import {
  createFeedbackClosingDedupeKey,
  FEEDBACK_CLOSING_DEDUPE_PREFIX,
  type FeedbackExtractionContext,
} from "./extraction.schemas.js";
import {
  buildFeedbackExtractionPrompt,
  estimatePromptTokens,
} from "./prompt.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";

const FEEDBACK_MODEL_VISIBLE_OUTBOX_STATUSES = new Set<MessageOutboxStatus>([
  "attempting",
  "ambiguous",
  "sending",
  "sent",
]);

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

export const FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS = [
  "authoritative_state_changed",
  "execution_claim_lost",
  "execution_invariant_broken",
] as const;

export type FeedbackConversationExecutionGuardReason =
  (typeof FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS)[number];

/**
 * Stops one provider/effects boundary without laundering orchestration state
 * into a model-generation failure.
 *
 * The queue adapter decides terminal behavior from `reason`: an ordinary state
 * change is a successful supersession, a lost lease remains retryable, and an
 * impossible cross-store shape is quarantined as unrecoverable.
 */
export class FeedbackConversationExecutionGuardError extends FeedbackProviderCallGuardError {
  constructor(
    conversationId: string,
    readonly reason: FeedbackConversationExecutionGuardReason,
  ) {
    super(`Feedback execution guard rejected ${conversationId}: ${reason}`);
    this.name = FeedbackConversationExecutionGuardError.name;
  }
}

export interface ExtractFeedbackInput {
  readonly conversationId: string;
  readonly correlationId: string;
  readonly executionClaim?: FeedbackConversationExecutionClaim;
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
 * The model turn selected by conversation reconciliation.
 *
 * Steady-state runs are serialized by the PostgreSQL execution fence for the
 * exact MongoDB work revision; the deterministic V1 job identity remains only
 * in the rollout bridge. The MongoDB extraction cursor makes either path
 * replay-safe. The run reloads authoritative state, selects candidates **live**
 * from current attendance (D16), asks the model for a proposal, validates that
 * proposal against the domain rules and only then writes anything.
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
    private readonly ingress: FeedbackIngressRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly audit: AuditRepository,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundLog: FeedbackOutboundLogService,
    @Inject(FEEDBACK_OPERATOR_ALERT)
    private readonly alert: FeedbackOperatorAlert,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
    private readonly executionFence: FeedbackConversationExecutionFence,
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
        // Both carried over rather than re-derived: this run called no model, so
        // it has no model id and no tier of its own, and it must not touch the
        // token totals the runs that *did* call one paid for. `usage` is left
        // out entirely — passing null would erase them.
        serviceTier: conversation.extraction.serviceTier,
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
    if (campaign.status !== "launched") {
      return this.complete(
        {
          outcome: "skipped_campaign_inactive",
          conversationId: conversation._id,
          cursorSeq: conversation.extraction.cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }
    const currentParticipant = await this.participants.findById(
      conversation.respondentParticipantId,
    );
    if (!currentParticipant?.postEventFeedbackWhatsappOptIn) {
      return this.complete(
        {
          outcome: "skipped_consent_withdrawn",
          conversationId: conversation._id,
          cursorSeq: conversation.extraction.cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }

    const context = await this.buildContext(conversation, campaign);
    const copy = resolveCampaignCopy(
      campaign.questions,
      campaign.questionSetVersion,
    );
    const prompt = buildFeedbackExtractionPrompt({ context, copy });
    const estimatedPromptTokens = estimatePromptTokens(prompt);
    const executionClaim = input.executionClaim;
    const beforeProviderCall = executionClaim
      ? () => this.assertExecutionCurrent(executionClaim, conversation)
      : undefined;

    const questionKeys = context.goals.map((goal) => goal.key);
    const [generated, attention] = await Promise.all(
      beforeProviderCall
        ? [
            this.generation.propose(prompt, questionKeys, beforeProviderCall),
            this.generation.classifyAttention(
              context.messages,
              context.newParticipantMessageIds,
              beforeProviderCall,
            ),
          ]
        : [
            this.generation.propose(prompt, questionKeys),
            this.generation.classifyAttention(
              context.messages,
              context.newParticipantMessageIds,
            ),
          ],
    );
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

    // The optional participant-facing rewrite is added later only when the
    // application would actually forward model text. Keep the paid usages in
    // one list so the durable total includes that third call when it exists.
    const runUsages: FeedbackExtractionUsage[] = [
      generated.usage,
      attention.usage,
    ];

    let validated = validateFeedbackExtractionProposal(
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
    // The two signals that end the questionnaire outright, as opposed to
    // flagging it. Both mean the same thing — from here a person is answering,
    // not the bot — so both hand control over, which is the existing brake:
    // `skipOutcome` refuses to run under human control and the planner refuses
    // to nudge a flagged conversation.
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
    // A hostile turn that never got a single answer out of anybody.
    //
    // Computed here, above the outbound, because the ending *sentence* and the
    // ending *word* are one judgement rather than two. Everything it needs is
    // already known at this point and none of it moves afterwards: `hostileTurn`
    // three lines up, and `answeredAnything` over the stored goals plus this
    // run's accepted answers — neither of which the goal settling further down
    // can change.
    //
    // It used to be computed after the outbound had already been chosen, and the
    // two halves duly disagreed. In paid rehearsal run 11 (2026-07-31,
    // openai/gpt-5.6-luna) Πάνος Μούλαρος refused three times and civilly — «δε
    // λεω τιποτα», «ασε με ρε φιλε», «ειπα δε λεω» — and the classifier judged
    // the middle one hostile. The lifecycle then did the right thing and stayed
    // `open` with `reason: null`, because a hostile turn with nothing behind it
    // is for an operator to read, not for us to file as finished. He was
    // nonetheless sent «Κανένα πρόβλημα, δεν θα σε ξαναρωτήσουμε. Καλή συνέχεια!
    // 🙂» — a written promise never to ask again, out of a conversation left in
    // precisely the state that permits asking again. Whichever way the operator
    // went next, one of those two was a lie.
    //
    // So it is one const, read by `progressClosing` immediately below and by
    // `closingNow` further down, and the sentence and the stored word cannot
    // drift apart again.
    const hostileWithoutAnswers =
      hostileTurn && !answeredAnything(conversation, validated);
    // Closing copy is only earned by answers/skips that already finished the
    // ladder. A withdrawal settles open goals *after* the outbound is chosen,
    // so the participant still gets the model's goodbye rather than the
    // campaign thank-you. `closingNow` below then decides from the settled
    // state, and excludes a withdrawal: settling the goals stops the reminders,
    // it does not end the conversation.
    //
    // `hostileWithoutAnswers` is excluded here and not only there, which is what
    // withholds Πάνος's «Κανένα πρόβλημα». Where the model wrote no goodbye of
    // its own the run then says nothing at all, and the silence is the honest
    // outbound: the conversation stays open, flagged `hostile_to_bot`, and a
    // person picks it up knowing exactly as much as we have promised. Where the
    // model did write something, that still goes out untouched — only the two
    // pieces of ending copy are ever withheld, never the bot's own words.
    //
    // The same const reaches `ordinaryReply` below, and that is right rather
    // than incidental: what survives this gate is now either nothing or an
    // ordinary conversational reply, and an ordinary reply is exactly the kind
    // that may be dropped for having been superseded while the model thought.
    const progressClosing =
      isCompleting(conversation.goals, recordedStatuses) &&
      validated.safetySignals.length === 0 &&
      !hostileWithoutAnswers;
    // Anchored on the participant's own latest message rather than on the
    // transcript length, because this run appends its reply to that same
    // transcript: a length-based key would differ on a replay that already sees
    // the reply, and a different `dedupe_key` is a second WhatsApp message.
    //
    // The cap sits between the choice and the assurance, so a question this run
    // is no longer allowed to ask takes nothing else out with it: there is no
    // outbound left for the assurance to append to, and a run that also carried
    // a disclosure still raises its own safety reason and its own alert from the
    // paths below. Saying the same sentence an eleventh time is not a way to
    // reassure anybody.
    const testimonySeq =
      latestParticipantMessage(conversation)?.seq ?? cursorSeq;
    let resolvedOutbound = resolveOutbound(
      conversation,
      validated,
      progressClosing,
      urgentSafety,
      testimonySeq,
      copy,
      recordedStatuses,
      stoppingForHostility,
    );
    // Extraction decides facts and progression at the configured medium
    // effort. Only text the outbound policy would genuinely forward is handed
    // to the low-effort conversational writer. Fixed handoff, safety,
    // questionnaire and closing copy never buys this extra call.
    let replyRewriteSuperseded = false;
    if (resolvedOutbound?.generatedByModel && validated.reply) {
      try {
        const rewritten = beforeProviderCall
          ? await this.generation.rewriteReply(
              prompt,
              validated.reply,
              beforeProviderCall,
            )
          : await this.generation.rewriteReply(prompt, validated.reply);
        runUsages.push(rewritten.usage);
        this.metrics.recordExtractTokens(
          {
            phase: "feedback_reply",
            model: rewritten.model,
            estimatedPromptTokens: rewritten.estimatedPromptTokens,
            inputTokens: rewritten.usage.inputTokens,
            outputTokens: rewritten.usage.outputTokens,
            totalTokens: rewritten.usage.totalTokens,
          },
          input.correlationId,
        );
        if (rewritten.reply === null) {
          // Deliberately do not re-resolve with `reply: null`: that path may
          // manufacture campaign-copy fallback text, including the same question
          // that just failed. A failed writer means silence for this turn.
          resolvedOutbound = undefined;
          this.logger.warn({
            event: "feedback.extract.reply_withheld",
            correlationId: input.correlationId,
            conversationId: conversation._id,
            reason: "reply_generation_failed",
          });
        } else {
          validated = { ...validated, reply: rewritten.reply };
          resolvedOutbound = resolveOutbound(
            conversation,
            validated,
            progressClosing,
            urgentSafety,
            testimonySeq,
            copy,
            recordedStatuses,
            stoppingForHostility,
          );
        }
      } catch (error) {
        if (
          error instanceof FeedbackConversationExecutionGuardError &&
          error.reason === "authoritative_state_changed"
        ) {
          // Extraction and attention have already crossed the provider boundary.
          // Keep their valid structured results, but do not buy or manufacture
          // participant-facing copy for a snapshot current state superseded.
          replyRewriteSuperseded = true;
          resolvedOutbound = undefined;
          this.logger.log({
            event: "feedback.extract.reply_withheld",
            correlationId: input.correlationId,
            conversationId: conversation._id,
            reason: "authoritative_state_changed_before_reply_rewrite",
          });
        } else {
          throw error;
        }
      }
    }
    const runUsage = combineFeedbackExtractionUsage(runUsages);
    const capped = withCampaignReaskCap(conversation, resolvedOutbound, copy);
    // Policy answers ride between the cap and the assurance: the cap decides
    // whether anything goes out at all, and the assurance stays the message's
    // last word — a promise about a disclosure outranks a sentence about
    // paperwork. Both appends survive each other by construction; each dedupes
    // against the transcript on its own sentence.
    const outbound = withSafetyAssurance(
      conversation,
      validated,
      withPolicyAnswers(
        conversation,
        capped.outbound,
        attention.policyQuestions,
      ),
      new Set(attention.describedIncidentMessageIds),
    );
    // The questions this run recognised and nobody has decided how to answer —
    // retention, anonymity, or no match at all. The participant got the model's
    // deferral; the raise below is what keeps the question alive for a person.
    const unansweredDataQuestionMessageIds = [
      ...new Set(
        attention.policyQuestions
          .filter((match) => isUnansweredPolicyQuestion(match.question))
          .map((match) => match.messageId),
      ),
    ];
    const ordinaryReply =
      !progressClosing && !validated.handoff && !stoppingForHostility;
    const withheld = outbound
      ? await this.reviewBeforeSending({
          conversation,
          cursorSeq,
          // Ordinary copy and a completion/decline decision are stale when the
          // participant has already added testimony. Handoff/safety/hostility
          // commitments survive: those stop automation for a person and do not
          // claim that the enlarged questionnaire is finished.
          staleOnNewerTestimony: ordinaryReply || progressClosing,
          ...(input.executionClaim
            ? { executionClaim: input.executionClaim }
            : {}),
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
    let withdrew =
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
    //
    // `hostileWithoutAnswers` is the one computed above the outbound, not a
    // second opinion formed down here. That is the whole of the fix for Πάνος:
    // the copy gate and this word gate now read the same const, so there is no
    // longer a state in which we say one and store the other.
    let hostility: FeedbackHostilityRaise = stoppingForHostility
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
    // Which ending this is, decided by the same judgement that chooses the copy.
    //
    // Πάνος Μούλαρος declined all four questions in three civil messages and was
    // stored as `completed` — the word for a finished questionnaire, in the
    // column a campaign's response rate is read from. The thank-you was already
    // withheld from him by `answeredAnything`, so the sentence he read and the
    // word we recorded had drifted apart; the only thing that stopped `completed`
    // was hostility, which makes a polite refusal the one that goes unnoticed.
    //
    // The three other endings of an empty ladder stay where they are and are not
    // this: a withdrawal keeps the conversation open because the bot gave up
    // rather than the participant, hostility keeps it open for an operator, and
    // a STOP is a consent decision rather than an answer to these questions.
    let closingReason: "completed" | "declined" | null =
      closingNow && !(progressClosing && withheld)
        ? answeredAnything(conversation, validated)
          ? "completed"
          : "declined"
        : null;
    if (replyRewriteSuperseded) {
      closingReason = null;
    }
    // Resolution deliberately happens before the lifecycle decision: a
    // model-authored goodbye can still turn out to be a withdrawal and must
    // retain its ordinary, dispatchable key. Once the final decision is
    // terminal, however, every flavour of closing copy must join the anchored
    // closing commitment used by replay suppression and the dispatcher.
    const outboundForPersistence =
      closingReason !== null && sentOutbound
        ? {
            ...sentOutbound,
            dedupeKey: createFeedbackClosingDedupeKey(
              conversation._id,
              testimonySeq,
              input.executionClaim?.workRevision,
            ),
          }
        : sentOutbound;

    const written = await this.persist({
      conversation,
      campaign,
      context,
      validated,
      outbound: outboundForPersistence,
      ordinaryReply,
      model: generated.model,
      correlationId: input.correlationId,
      closingReason,
      goalStatuses,
      ...(input.executionClaim ? { executionClaim: input.executionClaim } : {}),
    });

    if (
      written.outboundSuppressedByNewerIngress ||
      written.executionSuperseded
    ) {
      const suppressionReason = written.executionSuperseded
        ? "superseded_by_newer_work"
        : "superseded_by_durable_ingress";
      this.logger.log({
        event: "feedback.extract.outbound_withheld",
        correlationId: input.correlationId,
        conversationId: conversation._id,
        cursorSeq,
        reason: suppressionReason,
      });
      goalStatuses = withAskedGoal(recordedStatuses, undefined);
      withdrew =
        !dutyOfCare &&
        !stoppingForHostility &&
        validated.safetySignals.length === 0 &&
        isWithdrawal({
          answers: validated.answers,
          notes: validated.notes,
          nextGoal: validated.nextGoal,
          askedGoal: undefined,
          outboundSent: false,
          repairingStoredResults: validated.rejections.some(
            (rejection) => rejection.reason === "already_recorded",
          ),
        });
      if (withdrew) {
        goalStatuses = withSettledOpenGoals(conversation.goals, goalStatuses);
      }
      hostility = stoppingForHostility
        ? "stopped"
        : hostileWithoutAnswers &&
            isCompleting(conversation.goals, goalStatuses)
          ? "unanswerable"
          : "none";
      const closesAfterFence =
        isCompleting(conversation.goals, goalStatuses) &&
        validated.safetySignals.length === 0 &&
        !dutyOfCare &&
        !withdrew &&
        !stoppingForHostility &&
        !hostileWithoutAnswers;
      // The PostgreSQL ingress fence can see a fragment before MongoDB does.
      // Persist the valid snapshot results, but never close the conversation
      // over testimony the run did not read; the newer durable work revision
      // will reconcile that fragment next.
      closingReason = closingReason
        ? null
        : closesAfterFence
          ? answeredAnything(conversation, validated)
            ? "completed"
            : "declined"
          : null;
    }

    if (written.outboundSuppressedByLegacyClosing) {
      this.logger.warn({
        event: "feedback.extract.legacy_closing_provider_crossed",
        correlationId: input.correlationId,
        conversationId: conversation._id,
      });
      // The V1 row may already have reached WhatsApp. A second closing message
      // is forbidden, but treating an uncertain send as a clean completion is
      // equally dishonest. Keep the aggregate open, consume this testimony and
      // park it for an operator with the standard undelivered-message reason.
      closingReason = null;
    }

    if (
      input.executionClaim &&
      !(await this.executionFence.assertCurrent(input.executionClaim))
    ) {
      throw new FeedbackConversationExecutionGuardError(
        conversation._id,
        "execution_claim_lost",
      );
    }

    if (written.outboundSuppressedByLegacyClosing) {
      const at = new Date();
      await this.conversations.raiseAttention({
        conversationId: conversation._id,
        kind: "undelivered_message",
        messageId: null,
        at,
      });
    }

    // Nonterminal copy is recorded before the cursor, so a crash replays and
    // repairs the same outbox id. Terminal copy waits for the atomic MongoDB
    // close below; the dispatcher applies the same lifecycle guard, so a row
    // can never announce completion while the aggregate is still open.
    let effectiveOutbox = written.outbox;
    if (effectiveOutbox && closingReason === null) {
      await this.outboundTranscript.record(
        effectiveOutbox,
        new Date(),
        input.correlationId,
      );
    }

    const terminalReason = closingReason;
    const state = await this.applyConversationState({
      conversation,
      validated,
      goalStatuses,
      closingReason,
      terminalOutboxId:
        closingReason !== null ? (effectiveOutbox?.id ?? null) : null,
      dutyOfCare,
      withdrew,
      hostility,
      awaitingHuman:
        written.outboundSuppressedByLegacyClosing ||
        dutyOfCare ||
        withdrew ||
        hostility === "stopped",
      handoffOutboxId:
        closingReason === null &&
        (written.outboundSuppressedByLegacyClosing ||
          dutyOfCare ||
          withdrew ||
          hostility === "stopped")
          ? (effectiveOutbox?.id ?? null)
          : null,
      hostileTurn,
      priorHostileTurns: conversation.hostileTurns,
      newestParticipantMessageId:
        context.newParticipantMessageIds.at(-1) ?? null,
      stalledOnMessageId: capped.stalledOnMessageId,
      unansweredDataQuestionMessageIds,
      cursorSeq,
      model: generated.model,
      usage: runUsage,
      serviceTier: this.generation.serviceTier ?? null,
      correlationId: input.correlationId,
      workSuperseded: written.executionSuperseded || replyRewriteSuperseded,
      ...(input.executionClaim ? { executionClaim: input.executionClaim } : {}),
    });

    if (effectiveOutbox && terminalReason !== null) {
      if (state.terminalCommitted) {
        await this.outboundTranscript.record(
          effectiveOutbox,
          new Date(),
          input.correlationId,
        );
      } else {
        await this.database.transaction((transaction) =>
          this.outbox.cancelQueuedOutboxById(
            transaction,
            effectiveOutbox!.id,
            "terminal_snapshot_superseded",
          ),
        );
        effectiveOutbox = undefined;
        closingReason = null;
      }
    }

    await this.summaries.notifyIfLastConversationClosed(
      conversation.campaignId,
      input.correlationId,
      state.closedNow,
    );

    return this.complete(
      {
        // A safety signal is no longer an outcome of its own: the run extracted
        // normally and the flag is what an operator acts on. Only an explicit
        // handoff changes what the conversation did. Closing is deferred when
        // this run produced safety signals even if every goal is terminal.
        outcome: closingReason ?? (validated.handoff ? "handoff" : "extracted"),
        conversationId: conversation._id,
        cursorSeq,
        answersWritten: written.answersWritten,
        notesWritten: written.notesWritten,
        ...(effectiveOutbox ? { outboxId: effectiveOutbox.id } : {}),
        model: generated.model,
      },
      input.correlationId,
    );
  }

  /**
   * The five cheap exits from §7. Each one is reloaded state rather than a
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
   * Native V2 work already moves one durable due time after every fragment.
   * This check remains as a defensive fence for retained V1 wake-ups and work
   * scheduled by an older binary, whose fixed due time may arrive while the
   * participant is still typing.
   *
   * Deferring an early wake converts that old fixed window into a real settle:
   * a run only proceeds once nothing new has arrived for a full window. It
   * costs nothing,
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
    const transcriptOutboxIds = conversation.messages.flatMap((message) =>
      message.outboxId ? [message.outboxId] : [],
    );
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
      // Compatibility rule: an absent PostgreSQL row cannot prove that a
      // historical turn was never delivered, so it stays model-visible. Only
      // a present pre-send/failed/cancelled row is strong enough to remove the
      // Mongo audit-intent turn from provider context.
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
      // A disabled or absent venue was not supplied to the model, so enabling
      // one later cannot invalidate an otherwise venue-blind run.
      venueContextRevision: venue.venue === null ? null : venue.contextRevision,
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
   * Every reason but the last silences **every** kind of outbound, closing copy and
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
    readonly staleOnNewerTestimony: boolean;
    readonly executionClaim?: FeedbackConversationExecutionClaim;
  }): Promise<string | undefined> {
    const current = await this.conversations.findById(input.conversation._id);
    if (!current) {
      if (input.executionClaim) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          "execution_invariant_broken",
        );
      }
      return "conversation_missing";
    }
    if (input.executionClaim) {
      const guardReason = executionSnapshotGuardReason(
        current,
        input.conversation,
        input.executionClaim,
      );
      if (
        guardReason === "execution_claim_lost" ||
        guardReason === "execution_invariant_broken"
      ) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          guardReason,
        );
      }
      if (guardReason === "authoritative_state_changed") {
        if (current.lifecycle.state !== "open") {
          return "conversation_closed";
        }
        if (current.control.mode !== "bot") {
          return "human_control";
        }
        return "superseded_by_newer_work";
      }
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
      input.staleOnNewerTestimony &&
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
   * Rechecked inside the provider limiter's granted slot, before billing.
   *
   * This transaction is the durable provider-entry boundary. In one stable lock
   * order it fences inbound ingress, conversation control, campaign lifecycle,
   * consent and the execution token, then performs the last Mongo state read.
   * A mutation that began before this boundary blocks and invalidates the call;
   * one that begins after it is, by definition, later than provider entry. The
   * transaction commits before the network request and is never held over model
   * latency.
   */
  private async assertExecutionCurrent(
    claim: FeedbackConversationExecutionClaim,
    snapshot: FeedbackConversationDocument,
  ): Promise<void> {
    if (claim.conversationId !== snapshot._id) {
      throw new FeedbackConversationExecutionGuardError(
        snapshot._id,
        "execution_invariant_broken",
      );
    }
    await this.database.transaction(async (transaction) => {
      // Match webhook ingress first: a fragment already being acknowledged
      // commits before we inspect the durable row; a later fragment waits until
      // this provider-entry decision commits.
      await this.ingress.lockInboundPhone(transaction, snapshot.phoneAtLaunch);
      // STOP, takeover, close and awaiting-human transitions use this namespace.
      // It is deliberately second everywhere this method composes both locks.
      await this.results.lockConversation(transaction, snapshot._id);

      const executionCurrent = await this.executionFence.isCurrent(
        transaction,
        claim,
      );
      const campaign = await this.campaigns.findCampaignByIdForShare(
        transaction,
        snapshot.campaignId,
      );
      const participant = await this.participants.findByIdForUpdate(
        transaction,
        snapshot.respondentParticipantId,
      );
      const newerInbound = await this.ingress.hasInboundBeyondSnapshot(
        transaction,
        {
          phoneE164: snapshot.phoneAtLaunch,
          conversationId: snapshot._id,
          snapshotIngressIds: snapshot.messages.flatMap((message) =>
            message.actor === "participant" && message.ingressId
              ? [message.ingressId]
              : [],
          ),
        },
      );
      if (!executionCurrent) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "execution_claim_lost",
        );
      }
      if (!campaign || !participant) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "execution_invariant_broken",
        );
      }
      if (
        campaign.status !== "launched" ||
        !participant.postEventFeedbackWhatsappOptIn ||
        newerInbound
      ) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "authoritative_state_changed",
        );
      }

      // Mongo is deliberately last while every PostgreSQL writer fence remains
      // held. Once this read passes, commit is the provider-entry boundary.
      const conversation = await this.conversations.findById(snapshot._id);
      const guardReason = executionSnapshotGuardReason(
        conversation,
        snapshot,
        claim,
      );
      if (guardReason) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          guardReason,
        );
      }
    });
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
    readonly ordinaryReply: boolean;
    readonly model: string;
    readonly correlationId: string;
    readonly closingReason: "completed" | "declined" | null;
    readonly goalStatuses: readonly GoalStatusUpdate[];
    readonly executionClaim?: FeedbackConversationExecutionClaim;
  }): Promise<{
    answersWritten: number;
    notesWritten: number;
    outbox?: MessageOutboxRow;
    outboundSuppressedByNewerIngress: boolean;
    outboundSuppressedByLegacyClosing: boolean;
    executionSuperseded: boolean;
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
      let outboundSuppressedByNewerIngress = false;
      if (
        input.outbound &&
        (input.ordinaryReply || input.closingReason !== null)
      ) {
        await this.ingress.lockInboundPhone(
          transaction,
          input.conversation.phoneAtLaunch,
        );
        outboundSuppressedByNewerIngress =
          await this.ingress.hasInboundBeyondSnapshot(transaction, {
            phoneE164: input.conversation.phoneAtLaunch,
            conversationId: input.conversation._id,
            snapshotIngressIds: input.conversation.messages.flatMap(
              (message) =>
                message.actor === "participant" && message.ingressId
                  ? [message.ingressId]
                  : [],
            ),
          });
      }

      const venueRevision = input.context.venueContextRevision;
      if (
        typeof venueRevision === "number" &&
        !(await this.events.feedbackVenueContextIsCurrent(
          transaction,
          input.campaign.eventId,
          venueRevision,
        ))
      ) {
        // The event row is held under a shared lock through this transaction.
        // A venue edit that won the race makes this run retry; an edit that
        // arrives after the lock waits until the context-dependent outbox
        // decision is durable. No stale model reply is committed in between.
        throw new FeedbackExtractionGenerationError(
          "extraction_failed",
          true,
          "validation_failed",
        );
      }

      await this.results.lockConversation(transaction, input.conversation._id);

      // Match the provider-entry lock order. The execution row is acquired
      // only after the conversation mutex, so a post-provider commit cannot
      // deadlock an admission check that already holds that mutex. The lease
      // still fences relational effects; the Mongo generation below decides
      // whether this paid snapshot may speak or consume durable successor work.
      if (
        input.executionClaim &&
        !(await this.executionFence.renewWithin(
          transaction,
          input.executionClaim,
        ))
      ) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          "execution_claim_lost",
        );
      }

      const currentConversation = input.executionClaim
        ? await this.conversations.findById(input.conversation._id)
        : undefined;
      const executionGuardReason = input.executionClaim
        ? executionSnapshotGuardReason(
            currentConversation,
            input.conversation,
            input.executionClaim,
          )
        : undefined;
      if (
        executionGuardReason === "execution_claim_lost" ||
        executionGuardReason === "execution_invariant_broken"
      ) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          executionGuardReason,
        );
      }
      const executionSuperseded =
        executionGuardReason === "authoritative_state_changed";

      let answersWritten = 0;
      for (const answer of input.validated.answers) {
        // «άκυρο, τον Κώστα Π. καλύτερα όχι ξανά» moves a person, it does not
        // add a second opinion about them. Clearing the questions this one
        // contradicts is what makes the move a move.
        if (answer.subjectParticipantId) {
          await this.results.deleteContradictedAnswers(transaction, {
            conversationId: input.conversation._id,
            subjectParticipantId: answer.subjectParticipantId,
            questionKeys: contradictedPostEventFeedbackQuestionKeys(
              answer.questionKey,
              input.context.goals.map((goal) => goal.key),
            ),
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
      let outboundSuppressedByLegacyClosing = false;
      if (
        input.outbound &&
        input.closingReason !== null &&
        !outboundSuppressedByNewerIngress &&
        !executionSuperseded
      ) {
        const legacyClosing =
          await this.outbox.resolveLegacyClosingBeforeAnchoredInsert(
            transaction,
            `${FEEDBACK_CLOSING_DEDUPE_PREFIX}-${input.conversation._id}`,
          );
        outboundSuppressedByLegacyClosing =
          legacyClosing.outcome === "provider_crossed";
      }
      if (
        input.outbound &&
        !outboundSuppressedByNewerIngress &&
        !outboundSuppressedByLegacyClosing &&
        !executionSuperseded
      ) {
        const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
          conversationId: input.conversation._id,
          campaignId: input.campaign.id,
          kind: "reply",
          body: input.outbound.body,
          dedupeKey: input.outbound.dedupeKey,
        });
        await this.outboundLog.record(transaction, {
          outbox: enqueued,
          conversation: input.conversation,
          decision: {
            origin: "extraction_reply",
            model: input.model,
            confidence: input.validated.confidence ?? null,
            closingReason: input.closingReason,
            askedGoal: input.outbound.askedGoal ?? null,
            venueContextRevision: input.context.venueContextRevision ?? null,
            goalStatuses: input.goalStatuses.map(({ key, status }) => ({
              key,
              status,
            })),
          },
          correlationId: input.correlationId,
        });
        outbox = enqueued.row;
      }

      return {
        answersWritten,
        notesWritten,
        outboundSuppressedByNewerIngress,
        outboundSuppressedByLegacyClosing,
        executionSuperseded,
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
    readonly closingReason: "completed" | "declined" | null;
    /** Exact outbox row atomically authorized by an extraction-driven close. */
    readonly terminalOutboxId: string | null;
    readonly dutyOfCare: boolean;
    readonly withdrew: boolean;
    readonly hostility: FeedbackHostilityRaise;
    /** This snapshot atomically consumes its cursor and silences the bot. */
    readonly awaitingHuman: boolean;
    /** Exact participant-facing commitment allowed to survive the bot brake. */
    readonly handoffOutboxId: string | null;
    /** Whether this run advances the hostility ladder by one rung. */
    readonly hostileTurn: boolean;
    /** The count this run decided from — the compare-and-set's expected value. */
    readonly priorHostileTurns: number;
    /** The anchor for a reason this run raised that cites no message itself. */
    readonly newestParticipantMessageId: string | null;
    /**
     * The bot message whose campaign copy the re-ask cap refused to repeat, or
     * null. Its own anchor, so the raise is filed once rather than once per
     * message the participant sends afterwards.
     */
    readonly stalledOnMessageId: string | null;
    /**
     * Messages that asked a data-handling question we have deliberately not
     * answered. Each earns an `unanswered_data_question` reason on its anchor.
     */
    readonly unansweredDataQuestionMessageIds: readonly string[];
    readonly cursorSeq: number;
    readonly model: string;
    /** What this run's two model calls cost, added to the conversation's total. */
    readonly usage: FeedbackExtractionUsage;
    /** The tier this run bought, or null. Overwrites — it is not a quantity. */
    readonly serviceTier: string | null;
    readonly correlationId: string;
    /** A newer Mongo work/control generation owns the next state transition. */
    readonly workSuperseded: boolean;
    readonly executionClaim?: FeedbackConversationExecutionClaim;
  }): Promise<{
    readonly closedNow: boolean;
    readonly terminalCommitted: boolean;
  }> {
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
      input.stalledOnMessageId,
      input.unansweredDataQuestionMessageIds,
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

    // Results and operator evidence from the paid snapshot remain useful, but
    // a takeover/resume or another durable work generation owns the cursor and
    // every participant-facing transition from here. Leaving the cursor unread
    // is what keeps that successor discoverable instead of letting this old run
    // consume it after a human-control ABA.
    if (input.workSuperseded) {
      return { closedNow: false, terminalCommitted: false };
    }

    if (input.closingReason) {
      const closingReason = input.closingReason;
      const terminal = await this.database.transaction(async (transaction) => {
        // Total-order the terminal Mongo CAS with the dispatcher's final guard
        // and marker. If close wins, retract every pre-send row except the exact
        // closing row the lifecycle authorizes; if dispatch wins, its marker is
        // already durable before the lifecycle changes.
        await this.results.lockConversation(
          transaction,
          input.conversation._id,
        );
        const transition = await this.conversations.advanceCursorAndClose({
          conversationId: input.conversation._id,
          toSeq: input.cursorSeq,
          reason: closingReason,
          terminalOutboxId: input.terminalOutboxId,
          at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
          ...(input.executionClaim
            ? {
                workRevision: input.executionClaim.workRevision,
                executionEpoch: input.executionClaim.epoch,
              }
            : {}),
        });
        const committed =
          transition.changed ||
          (transition.conversation.lifecycle.state === "closed" &&
            transition.conversation.lifecycle.reason === closingReason &&
            transition.conversation.lifecycle.terminalOutboxId ===
              input.terminalOutboxId);
        if (committed) {
          await this.outbox.cancelQueuedOutboxForConversationExceptId(
            transaction,
            input.conversation._id,
            input.terminalOutboxId,
          );
        }
        return { transition, committed };
      });
      if (terminal.transition.changed) {
        return { closedNow: true, terminalCommitted: true };
      }
      if (terminal.committed) {
        return { closedNow: false, terminalCommitted: true };
      }

      // Only actual newer testimony makes consuming this snapshot safe: it
      // leaves a later participant turn for the successor to discover. A
      // control/pause generation change with no newer testimony must keep the
      // cursor unread, otherwise the successor has nothing from which to repair
      // the terminal close and can incorrectly remind or expire the thread.
      if (
        terminal.transition.conversation.messages.some(
          (message) =>
            message.actor === "participant" && message.seq > input.cursorSeq,
        )
      ) {
        await this.conversations.advanceCursor({
          conversationId: input.conversation._id,
          toSeq: input.cursorSeq,
          at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
        });
      }
      return { closedNow: false, terminalCommitted: false };
    }

    if (input.awaitingHuman) {
      await this.database.transaction(async (transaction) => {
        // Cursor/accounting and the bot brake are one Mongo write under the same
        // mutex as provider entry. Neither half can survive a crash alone.
        await this.results.lockConversation(
          transaction,
          input.conversation._id,
        );
        const transition =
          await this.conversations.advanceCursorAndMarkAwaitingHuman({
            conversationId: input.conversation._id,
            toSeq: input.cursorSeq,
            at,
            model: input.model,
            serviceTier: input.serviceTier,
            usage: input.usage,
            ...(input.executionClaim
              ? {
                  workRevision: input.executionClaim.workRevision,
                  executionEpoch: input.executionClaim.epoch,
                }
              : {}),
          });
        const committed =
          transition.changed || transition.conversation.awaitingHuman;
        await this.outbox.cancelQueuedAutomatedOutboxForConversation(
          transaction,
          input.conversation._id,
          committed ? input.handoffOutboxId : null,
        );
        if (!committed) {
          const guardReason = input.executionClaim
            ? (executionSnapshotGuardReason(
                transition.conversation,
                input.conversation,
                input.executionClaim,
              ) ?? "execution_invariant_broken")
            : "authoritative_state_changed";
          throw new FeedbackConversationExecutionGuardError(
            input.conversation._id,
            guardReason,
          );
        }
      });
    } else {
      await this.conversations.advanceCursor({
        conversationId: input.conversation._id,
        toSeq: input.cursorSeq,
        at,
        model: input.model,
        serviceTier: input.serviceTier,
        usage: input.usage,
        ...(input.executionClaim
          ? {
              workRevision: input.executionClaim.workRevision,
              executionEpoch: input.executionClaim.epoch,
            }
          : {}),
      });
    }

    // The atomic path above closes this run's window in the same write that
    // makes the bot quiet — neither half can strand the other after a crash.
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
    // here: the hostility ladder still has rungs left — the questionnaire is
    // finished, but the counter has not reached the exit line — so the bot keeps
    // its voice and only the badge goes up.
    return { closedNow: false, terminalCommitted: false };
  }

  private complete(
    result: ExtractFeedbackResult,
    correlationId: string,
  ): ExtractFeedbackResult {
    this.metrics.recordExtractOutcome(result.outcome, correlationId);
    return result;
  }
}

/** Classifies the Mongo half of one PostgreSQL execution claim. */
function executionSnapshotGuardReason(
  current: FeedbackConversationDocument | undefined,
  snapshot: FeedbackConversationDocument,
  claim: FeedbackConversationExecutionClaim,
): FeedbackConversationExecutionGuardReason | undefined {
  if (
    claim.conversationId !== snapshot._id ||
    !snapshot.work ||
    !current ||
    !current.work
  ) {
    return "execution_invariant_broken";
  }

  if (current.work.executionEpoch > claim.epoch) {
    return "execution_claim_lost";
  }
  if (current.work.executionEpoch < claim.epoch) {
    return "execution_invariant_broken";
  }
  if (current.work.revision > claim.workRevision) {
    return "authoritative_state_changed";
  }
  if (current.work.revision < claim.workRevision) {
    return "execution_invariant_broken";
  }
  if (
    current.lifecycle.state !== "open" ||
    current.control.mode !== "bot" ||
    current.awaitingHuman ||
    current.control.changedAt.getTime() !== snapshot.control.changedAt.getTime()
  ) {
    return "authoritative_state_changed";
  }
  return undefined;
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
