import type { FeedbackConversationDocument } from "./post-event-feedback-conversation.document.js";
import type { FakeFeedbackConversations } from "./post-event-feedback-doubles.harness.js";
import {
  FeedbackExtractionGenerationError,
  type FeedbackAttentionClassificationGenerationResult,
  type FeedbackExtractionGenerationResult,
} from "./extraction/model.service.js";
import {
  FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES,
  feedbackExtractionGoalVerdicts,
  feedbackExtractionProposalSchema,
  type FeedbackExtractionMessageView,
  type FeedbackExtractionProposal,
} from "./extraction/extraction.schemas.js";
import type {
  AttentionTurn,
  Cite,
  ModelFailure,
  ModelTurn,
  ScriptedAttentionTurn,
} from "./post-event-feedback-loop-scenario.js";

// ── The scripted model ──────────────────────────────────────────────────────

export const SCRIPT_MODEL = "google/gemini-3.6-flash";
const SCRIPT_USAGE = { inputTokens: 800, outputTokens: 110, totalTokens: 910 };

export interface ScriptedModelPause {
  /** Resolves only after the provider boundary has been entered. */
  readonly started: Promise<void>;
  /** Let the provider call return to the extractor. Idempotent. */
  release(): void;
}

interface PendingModelPause {
  readonly phase: "extraction" | "attention";
  readonly started: Promise<void>;
  markStarted(): void;
  readonly released: Promise<void>;
  release(): void;
}

/**
 * The model boundary, driven by a scenario's script.
 *
 * `propose` receives rendered Greek prose and must answer with transcript
 * message **ids** the scenario cannot know in advance, so the job driver tells
 * this class which conversation the run is about and citations are resolved
 * here against the live transcript. Every proposal is parsed by the real
 * proposal schema before it is returned, exactly as the production boundary
 * does, so a scripted turn cannot smuggle in a shape the provider could not
 * have produced.
 */
export class ScriptedExtractionModel {
  private turns: readonly ModelTurn[] = [];
  private attentionTurns: readonly AttentionTurn[] = [];
  private turnIndex = 0;
  private attentionIndex = 0;
  private failuresTaken = 0;
  private runConversationId: string | undefined;
  private readonly attemptedTurnIndexes = new Set<number>();
  private readonly emittedFailures: ModelFailure[] = [];
  private pendingPause: PendingModelPause | undefined;
  private allowUnscriptedExtractionCalls = false;

  constructor(
    private readonly conversations: FakeFeedbackConversations,
    private readonly idByName: ReadonlyMap<string, string>,
  ) {}

  script(
    turns: readonly ModelTurn[],
    allowUnscriptedExtractionCalls = false,
  ): void {
    this.turns = [...turns];
    this.turnIndex = 0;
    this.failuresTaken = 0;
    this.attemptedTurnIndexes.clear();
    this.emittedFailures.splice(0);
    this.allowUnscriptedExtractionCalls = allowUnscriptedExtractionCalls;
  }

  scriptAttention(turns: readonly AttentionTurn[]): void {
    this.attentionTurns = [...turns];
    this.attentionIndex = 0;
  }

  /** Called by the job driver immediately before an extraction job is dispatched. */
  beginRun(conversationId: string): void {
    this.runConversationId = conversationId;
  }

  /**
   * Pause exactly the next provider call at the requested phase. The extractor
   * has already snapshotted its context when `started` resolves.
   */
  pauseNext(
    phase: "extraction" | "attention" = "extraction",
  ): ScriptedModelPause {
    if (this.pendingPause) {
      throw new Error("A scripted model pause is already waiting");
    }
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingPause = {
      phase,
      started,
      markStarted,
      released,
      release,
    };
    return { started, release };
  }

  /** The 1-based scripted call positions that no provider call reached. */
  get unconsumedExtractionCalls(): readonly number[] {
    return this.turns.flatMap((_turn, index) =>
      this.attemptedTurnIndexes.has(index) ? [] : [index + 1],
    );
  }

  /** The 1-based attention call positions that no classifier call reached. */
  get unconsumedAttentionCalls(): readonly number[] {
    return this.attentionTurns.flatMap((_turn, index) =>
      index < this.attentionIndex ? [] : [index + 1],
    );
  }

  /** Debugging aid retained for direct harness callers. */
  get unusedTurns(): number {
    return this.unconsumedExtractionCalls.length;
  }

  takeEmittedFailure(): ModelFailure | undefined {
    return this.emittedFailures.shift();
  }

  async propose(): Promise<FeedbackExtractionGenerationResult> {
    const conversation = this.requireRunConversation();
    await this.waitAtPause("extraction");
    const turn = this.turns[this.turnIndex];
    if (!turn) {
      if (this.allowUnscriptedExtractionCalls) {
        return this.emit(buildProposal({}, conversation, this.idByName));
      }
      throw new Error(
        `Unexpected extraction provider call ${this.turnIndex + 1}: the scenario script is exhausted`,
      );
    }

    this.attemptedTurnIndexes.add(this.turnIndex);
    const failure = this.takeScriptedFailure(turn);
    if (failure) {
      throw failure;
    }
    this.turnIndex += 1;
    this.failuresTaken = 0;
    return this.emit(buildProposal(turn, conversation, this.idByName));
  }

  async classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    await this.waitAtPause("attention");
    const scripted = this.attentionTurns[this.attentionIndex] ?? [];
    this.attentionIndex += 1;
    const turn: ScriptedAttentionTurn = Array.isArray(scripted)
      ? { signals: scripted, hostileToUs: false }
      : (scripted as ScriptedAttentionTurn);
    return {
      model: SCRIPT_MODEL,
      usage: { inputTokens: 180, outputTokens: 40, totalTokens: 220 },
      estimatedPromptTokens: 200,
      signals: (turn.signals ?? []).map((signal) => ({
        category: signal.category,
        recommendedAction: signal.action,
        sourceMessageIds: resolveAttentionCite(
          signal.on ?? "all-new",
          messages,
          targetMessageIds,
        ),
        confidence: signal.confidence ?? 0.9,
      })),
      // The same cite resolution as the signal above, so a scenario cannot end
      // up with a signal on one message and its description on another.
      describedIncidentMessageIds: [
        ...new Set(
          (turn.signals ?? [])
            .filter((signal) => !signal.announcedOnly)
            .flatMap((signal) =>
              resolveAttentionCite(
                signal.on ?? "all-new",
                messages,
                targetMessageIds,
              ),
            ),
        ),
      ],
      // Every target message, because the ladder counts runs rather than
      // messages: a scenario says whether this turn was hostile, not which
      // fragment of a burst carried the insult.
      hostileMessageIds: turn.hostileToUs ? [...targetMessageIds] : [],
      // Attached to the newest new message — the one that asked. A scenario
      // scripting a question on a run with no new messages is a script error
      // surfaced by the empty list, not silently reattributed.
      policyQuestions:
        targetMessageIds.length > 0
          ? (turn.policyQuestions ?? []).map((question) => ({
              messageId: targetMessageIds.at(-1) as string,
              question,
            }))
          : [],
    };
  }

  private emit(
    proposal: Record<string, unknown>,
  ): FeedbackExtractionGenerationResult {
    let parsed: FeedbackExtractionProposal;
    try {
      parsed = feedbackExtractionProposalSchema.parse(proposal);
    } catch {
      // The production boundary reports a response that never satisfied the
      // agreed schema exactly this way.
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }
    return { model: SCRIPT_MODEL, proposal: parsed, usage: SCRIPT_USAGE };
  }

  private takeScriptedFailure(turn: ModelTurn): Error | undefined {
    if (!turn.fails) {
      return undefined;
    }
    this.failuresTaken += 1;
    this.emittedFailures.push(turn.fails);
    return modelFailure(turn.fails);
  }

  private async waitAtPause(phase: PendingModelPause["phase"]): Promise<void> {
    const pause = this.pendingPause;
    if (!pause || pause.phase !== phase) {
      return;
    }
    this.pendingPause = undefined;
    pause.markStarted();
    await pause.released;
  }

  private requireRunConversation(): FeedbackConversationDocument {
    if (!this.runConversationId) {
      throw new Error(
        "The scripted model was called outside an extraction run",
      );
    }
    return this.conversations.get(this.runConversationId);
  }
}

function modelFailure(
  failure: ModelFailure,
): FeedbackExtractionGenerationError {
  switch (failure) {
    case "unavailable":
      return new FeedbackExtractionGenerationError(
        "provider_unavailable",
        false,
        "provider_error",
      );
    case "refuses":
      return new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "provider_refusal",
      );
    case "malformed":
      return new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    default:
      return new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "provider_error",
      );
  }
}

function buildProposal(
  turn: ModelTurn,
  conversation: FeedbackConversationDocument,
  idByName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const subject = (
    about: string | undefined,
  ): { id: string | null; mentioned: string | null } => {
    if (!about) {
      return { id: null, mentioned: null };
    }
    return { id: idByName.get(about) ?? null, mentioned: about };
  };

  return {
    goals: feedbackExtractionGoalVerdicts({
      answered: (turn.answers ?? []).map((answer) => {
        const resolved = subject(answer.about);
        return {
          questionKey: answer.question,
          valueInt: answer.value ?? null,
          subjectParticipantId: resolved.id,
          subjectMentionedName: resolved.mentioned,
          sourceMessageIds: resolveCite(answer.cite ?? "all-new", conversation),
          confidence: answer.confidence ?? 0.9,
        };
      }),
      declined: [...(turn.skip ?? [])].map((questionKey) => ({
        questionKey,
        sourceMessageIds: resolveCite("all-new", conversation),
      })),
    }),
    notes: (turn.notes ?? []).map((note) => {
      const resolved = subject(note.about);
      return {
        noteType: note.type ?? "general",
        text: note.text,
        subjectParticipantId: resolved.id,
        subjectMentionedName: resolved.mentioned,
        sourceMessageIds: resolveCite(note.cite ?? "all-new", conversation),
        confidence: note.confidence ?? 0.7,
      };
    }),
    nextGoal: turn.next ?? null,
    reply: turn.reply ?? null,
    handoff: turn.handoff ?? false,
    confidence: turn.confidence ?? 0.9,
  };
}

function resolveCite(
  cite: Cite,
  conversation: FeedbackConversationDocument,
): string[] {
  const participant = conversation.messages.filter(
    (message) => message.actor === "participant",
  );
  const unread = participant.filter(
    (message) => message.seq > conversation.extraction.cursorSeq,
  );
  const pick = (reference: string | number): string[] => {
    if (typeof reference === "number") {
      const message = participant[reference - 1];
      if (!message) {
        throw new Error(
          `The scenario cited participant message #${reference}, which does not exist`,
        );
      }
      return [message.id];
    }
    switch (reference) {
      case "all-new":
        return (unread.length > 0 ? unread : participant.slice(-1)).map(
          (message) => message.id,
        );
      case "last":
        return participant.at(-1) ? [participant.at(-1)!.id] : [];
      case "bot": {
        const bot = conversation.messages.filter(
          (message) => message.actor === "bot",
        );
        return bot.at(-1) ? [bot.at(-1)!.id] : [];
      }
      default: {
        const match = participant.find(
          (message) => message.text === reference.trim(),
        );
        if (!match) {
          throw new Error(
            `The scenario cited a participant message reading "${reference}", which was never sent`,
          );
        }
        return [match.id];
      }
    }
  };

  const references = Array.isArray(cite)
    ? (cite as readonly (string | number)[])
    : [cite as string | number];
  const ids = [...new Set(references.flatMap((reference) => pick(reference)))];
  if (ids.length === 0) {
    throw new Error(
      "The scenario scripted an extraction before the participant said anything",
    );
  }
  // Do not trim to the production bound here. The real proposal schema must
  // accept or reject exactly what the scenario scripted; slicing with the same
  // constant would let a bound regression silently rewrite the test input.
  return ids;
}

function resolveAttentionCite(
  cite: Cite,
  messages: readonly FeedbackExtractionMessageView[],
  targetMessageIds: readonly string[],
): string[] {
  if (cite === "all-new") {
    return [...targetMessageIds].slice(
      0,
      FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES,
    );
  }
  if (cite === "last") {
    const last = targetMessageIds.at(-1);
    return last ? [last] : [];
  }
  const references = Array.isArray(cite)
    ? (cite as readonly (string | number)[])
    : [cite as string | number];
  const participant = messages.filter(
    (message) => message.actor === "participant",
  );
  return references.flatMap((reference) => {
    if (typeof reference === "number") {
      const message = participant[reference - 1];
      return message ? [message.id] : [];
    }
    const match = participant.find(
      (message) => message.text === reference.trim(),
    );
    return match ? [match.id] : [];
  });
}
