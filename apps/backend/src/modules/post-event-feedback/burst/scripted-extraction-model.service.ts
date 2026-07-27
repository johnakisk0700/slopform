import { Injectable } from "@nestjs/common";

import type {
  FeedbackExtractionMessageView,
  FeedbackExtractionProposal,
  FeedbackExtractionSafetySignalProposal,
} from "../extraction/extraction.schemas.js";
import { feedbackExtractionProposalSchema } from "../extraction/extraction.schemas.js";
import {
  FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE,
  FeedbackAttentionClassificationValidationError,
} from "../extraction/attention-classification.js";
import {
  FEEDBACK_EXTRACTION_STUB_MODEL_ID,
  FeedbackExtractionGenerationError,
  type FeedbackAttentionClassificationGenerationResult,
  type FeedbackExtractionGenerationResult,
  type FeedbackExtractionModelPort,
} from "../extraction/model.service.js";
import type { FeedbackExtractionPrompt } from "../extraction/prompt.js";
import type {
  BurstCitation,
  BurstPersona,
  BurstStubAttentionSignal,
  BurstStubTurn,
} from "./burst-scenario.js";
import {
  parseBurstExtractionPrompt,
  type ParsedBurstCandidate,
  type ParsedBurstExtractionPrompt,
} from "./parse-burst-extraction-prompt.js";

/** Obviously fabricated — never a plausible billing figure. */
const SCRIPTED_USAGE = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
} as const;

interface ClaimedStubTurn {
  readonly persona: BurstPersona;
  readonly turn: BurstStubTurn;
  readonly turnIndex: number;
}

/**
 * Deterministic stand-in for `PostEventFeedbackExtractionModel` during the
 * multi-campaign burst rehearsal.
 *
 * It answers from the persona catalogue by parsing the rendered prompt — the
 * only input the extraction seam gives it — so a rehearsal failure is a
 * mechanism defect, not a model whim.
 */
@Injectable()
export class ScriptedBurstExtractionModel implements FeedbackExtractionModelPort {
  /**
   * Turn cursor keyed by persona id.
   *
   * The rendered prompt never carries a conversation id, and recovering one
   * from the persona's phone would need a store this stub does not own.
   * Persona ids are unique across all three campaigns, so they are a stable
   * per-conversation key for the rehearsal.
   *
   * `propose` and `classifyAttention` run concurrently for one extraction job
   * (`Promise.all` in the extractor). Both must see the same stub turn, so a
   * turn is claimed once per (personaId, new-message fingerprint) and reused
   * for the sibling call rather than advanced twice.
   */
  private readonly nextTurnIndexByPersonaId = new Map<string, number>();
  private readonly claimedTurns = new Map<string, ClaimedStubTurn>();

  /**
   * The id every run reports, and the same one written to `extraction.model`.
   * Anything reading a conversation after a rehearsal can tell at a glance that
   * no provider produced it.
   */
  readonly model = FEEDBACK_EXTRACTION_STUB_MODEL_ID;

  constructor(private readonly personas: readonly BurstPersona[]) {}

  async propose(
    prompt: FeedbackExtractionPrompt,
  ): Promise<FeedbackExtractionGenerationResult> {
    try {
      const parsed = parseBurstExtractionPrompt(prompt.user);
      const { turn, persona } = this.claimTurn(
        parsed.newMessageIds,
        textsForIds(parsed, parsed.newMessageIds),
      );
      const proposal = buildProposal(turn, parsed, persona);
      return {
        model: FEEDBACK_EXTRACTION_STUB_MODEL_ID,
        proposal: feedbackExtractionProposalSchema.parse(proposal),
        usage: SCRIPTED_USAGE,
      };
    } catch (error) {
      throw toScriptedError(error);
    }
  }

  async classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    try {
      // Honour the real model's batching bound: each batch is at most
      // FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE targets. Nothing is called,
      // but signal sources stay inside one batch the way a single provider
      // round-trip would have scoped them.
      const batches = chunk(
        targetMessageIds,
        FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE,
      );
      if (targetMessageIds.length === 0) {
        return {
          model: FEEDBACK_EXTRACTION_STUB_MODEL_ID,
          signals: [],
          usage: SCRIPTED_USAGE,
          estimatedPromptTokens: 0,
        };
      }

      const texts = targetMessageIds.map((id) => {
        const message = messages.find((entry) => entry.id === id);
        if (!message) {
          throw scriptFailure(
            `Scripted attention target ${id} is missing from the transcript`,
          );
        }
        return message.text;
      });
      const { turn } = this.claimTurn(targetMessageIds, texts);
      const signals = (turn.attention ?? []).flatMap((signal) =>
        expandAttentionSignal(signal, targetMessageIds, batches),
      );

      return {
        model: FEEDBACK_EXTRACTION_STUB_MODEL_ID,
        signals,
        usage: SCRIPTED_USAGE,
        estimatedPromptTokens: 0,
      };
    } catch (error) {
      throw toScriptedError(error);
    }
  }

  private claimTurn(
    messageIds: readonly string[],
    texts: readonly string[],
  ): ClaimedStubTurn {
    const persona = matchPersona(this.personas, texts);
    const key = `${persona.id}::${messageIds.join(",")}`;
    const existing = this.claimedTurns.get(key);
    if (existing) {
      return existing;
    }

    const turnIndex = this.nextTurnIndexByPersonaId.get(persona.id) ?? 0;
    const turn = persona.stub[turnIndex];
    if (!turn) {
      throw scriptFailure(
        `Scripted burst persona ${persona.id} exhausted its stub after ${turnIndex} turns`,
      );
    }

    const claimed: ClaimedStubTurn = { persona, turn, turnIndex };
    this.claimedTurns.set(key, claimed);
    this.nextTurnIndexByPersonaId.set(persona.id, turnIndex + 1);
    return claimed;
  }
}

function buildProposal(
  turn: BurstStubTurn,
  parsed: ParsedBurstExtractionPrompt,
  _persona: BurstPersona,
): FeedbackExtractionProposal {
  const confidence = turn.confidence ?? 0.9;
  const byName = candidateIndex(parsed.candidates);

  return {
    answers: (turn.answers ?? []).map((answer) => {
      const subject = resolveSubject(answer.about, undefined, byName, {
        required: answer.question !== "event_score",
      });
      return {
        questionKey: answer.question,
        valueInt: answer.value ?? null,
        subjectParticipantId: subject.participantId,
        subjectMentionedName: subject.mentionedName,
        sourceMessageIds: resolveCite(
          answer.cite ?? "all-new",
          parsed.newMessageIds,
        ),
        confidence,
      };
    }),
    notes: (turn.notes ?? []).map((note) => {
      const subject = resolveSubject(note.about, note.mentionedName, byName, {
        required: false,
      });
      return {
        noteType: note.type,
        text: note.text,
        subjectParticipantId: subject.participantId,
        subjectMentionedName: subject.mentionedName,
        sourceMessageIds: resolveCite(
          note.cite ?? "all-new",
          parsed.newMessageIds,
        ),
        confidence,
      };
    }),
    skippedGoals: [...(turn.skippedGoals ?? [])],
    nextGoal: turn.nextGoal === undefined ? null : turn.nextGoal,
    reply: turn.reply === undefined ? null : turn.reply,
    handoff: turn.handoff ?? false,
    confidence,
  };
}

function resolveSubject(
  about: string | undefined,
  mentionedName: string | undefined,
  byName: ReadonlyMap<string, string>,
  options: { readonly required: boolean },
): { participantId: string | null; mentionedName: string | null } {
  if (about) {
    const participantId = byName.get(about.trim());
    if (!participantId) {
      throw scriptFailure(
        `Scripted burst about "${about}" is not in the ΥΠΟΨΗΦΙΟΙ block`,
      );
    }
    return {
      participantId,
      mentionedName: mentionedName?.trim() || null,
    };
  }
  if (mentionedName) {
    return { participantId: null, mentionedName: mentionedName.trim() };
  }
  if (options.required) {
    throw scriptFailure(
      "Scripted burst directed answer is missing an about display name",
    );
  }
  return { participantId: null, mentionedName: null };
}

export function resolveCite(
  cite: BurstCitation,
  newMessageIds: readonly string[],
): string[] {
  if (newMessageIds.length === 0) {
    throw scriptFailure(
      "Scripted burst cite resolved against an empty new-message list",
    );
  }
  switch (cite) {
    case "all-new":
      return [...newMessageIds];
    case "last":
      return [newMessageIds.at(-1)!];
    case "first":
      return [newMessageIds[0]!];
  }
}

function expandAttentionSignal(
  signal: BurstStubAttentionSignal,
  targetMessageIds: readonly string[],
  batches: readonly (readonly string[])[],
): FeedbackExtractionSafetySignalProposal[] {
  const cited = resolveCite(signal.on, targetMessageIds);
  const firstBatch = cited[0]
    ? batches.find((batch) => batch.includes(cited[0]!))
    : undefined;
  const scoped =
    firstBatch === undefined
      ? cited
      : cited.filter((id) => firstBatch.includes(id));
  if (scoped.length === 0) {
    throw new FeedbackAttentionClassificationValidationError(
      "Scripted attention cite resolved outside the classification batches",
    );
  }
  return signal.categories.map((category) => ({
    category,
    recommendedAction: signal.action,
    sourceMessageIds: scoped,
    confidence: 0.9,
  }));
}

function textsForIds(
  parsed: ParsedBurstExtractionPrompt,
  ids: readonly string[],
): string[] {
  const byId = new Map(
    parsed.transcript.map((message) => [message.id, message.text] as const),
  );
  return ids.map((id) => {
    const text = byId.get(id);
    if (text === undefined) {
      throw scriptFailure(
        `Scripted burst new message ${id} is missing from ΣΥΝΟΜΙΛΙΑ`,
      );
    }
    return text;
  });
}

export function matchBurstPersona(
  personas: readonly BurstPersona[],
  texts: readonly string[],
): BurstPersona {
  return matchPersona(personas, texts);
}

function matchPersona(
  personas: readonly BurstPersona[],
  texts: readonly string[],
): BurstPersona {
  const trimmed = texts.map((text) => text.trim());
  const matchedIds = new Set<string>();
  const matched: BurstPersona[] = [];

  for (const persona of personas) {
    const personaTexts = new Set(
      persona.messages.map((message) => message.text.trim()),
    );
    if (!trimmed.some((text) => personaTexts.has(text))) {
      continue;
    }
    if (matchedIds.has(persona.id)) {
      continue;
    }
    matchedIds.add(persona.id);
    matched.push(persona);
  }

  if (matched.length === 0) {
    throw scriptFailure(
      "Scripted burst new messages matched no BURST_PERSONAS entry",
    );
  }
  if (matched.length > 1) {
    throw scriptFailure(
      `Scripted burst new messages matched multiple personas: ${matched
        .map((persona) => persona.id)
        .join(", ")}`,
    );
  }
  return matched[0]!;
}

function candidateIndex(
  candidates: readonly ParsedBurstCandidate[],
): Map<string, string> {
  return new Map(
    candidates.map((candidate) => [
      candidate.displayName.trim(),
      candidate.participantId,
    ]),
  );
}

function chunk<T>(items: readonly T[], size: number): readonly T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function scriptFailure(message: string): FeedbackExtractionGenerationError {
  const error = new FeedbackExtractionGenerationError(
    "extraction_failed",
    false,
    "validation_failed",
  );
  error.message = message;
  return error;
}

function toScriptedError(error: unknown): FeedbackExtractionGenerationError {
  if (error instanceof FeedbackExtractionGenerationError) {
    return error;
  }
  if (error instanceof FeedbackAttentionClassificationValidationError) {
    return new FeedbackExtractionGenerationError(
      "extraction_failed",
      false,
      "validation_failed",
    );
  }
  return new FeedbackExtractionGenerationError(
    "extraction_failed",
    false,
    "unknown",
  );
}
