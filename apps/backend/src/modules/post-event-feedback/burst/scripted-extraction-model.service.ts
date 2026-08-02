import { Injectable } from "@nestjs/common";
import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";

import type {
  FeedbackExtractionMessageView,
  FeedbackExtractionProposal,
  FeedbackExtractionSafetySignalProposal,
} from "../extraction/extraction.schemas.js";
import {
  createFeedbackExtractionProposalSchema,
  feedbackExtractionGoalVerdicts,
} from "../extraction/extraction.schemas.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "../jobs.schemas.js";
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
   * Resolve the scripted turn from the new-message cluster itself.
   *
   * The rendered prompt never carries a conversation id, and recovering one
   * from the persona's phone would need a store this stub does not own.
   * More importantly, an in-memory cursor is process-local: with two workers,
   * turn one can run in worker A and turn two in worker B, whose fresh cursor
   * would replay turn one and drive the real validator into the fallback.
   * Persona message gaps already define the quiet-window clusters, so the
   * target texts are a deterministic, worker-independent turn key. `propose`
   * and `classifyAttention` consequently resolve the same turn without shared
   * mutable state.
   */
  /**
   * The id every run reports, and the same one written to `extraction.model`.
   * Anything reading a conversation after a rehearsal can tell at a glance that
   * no provider produced it.
   */
  readonly model = FEEDBACK_EXTRACTION_STUB_MODEL_ID;

  /**
   * A stub never bought a fast lane. `undefined` rather than `"default"` for the
   * same reason the real model leaves it unset when nothing is configured: the
   * two are not the same claim, and only one of them is true here.
   */
  readonly serviceTier = undefined;

  constructor(private readonly personas: readonly BurstPersona[]) {}

  async propose(
    prompt: FeedbackExtractionPrompt,
    questionKeys: readonly FeedbackAnswerQuestionKey[],
  ): Promise<FeedbackExtractionGenerationResult> {
    try {
      const parsed = parseBurstExtractionPrompt(prompt.user);
      const { turn, persona } = this.claimTurn(
        textsForIds(parsed, parsed.newMessageIds),
      );
      const proposal = buildProposal(turn, parsed, persona, questionKeys);
      return {
        model: FEEDBACK_EXTRACTION_STUB_MODEL_ID,
        proposal:
          createFeedbackExtractionProposalSchema(questionKeys).parse(proposal),
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
          hostileMessageIds: [],
          describedIncidentMessageIds: [],
          policyQuestions: [],
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
      const { turn } = this.claimTurn(texts);
      const signals = (turn.attention ?? []).flatMap((signal) =>
        expandAttentionSignal(signal, targetMessageIds, batches),
      );
      const describedIncidentMessageIds = [
        ...new Set(
          (turn.attention ?? [])
            .filter((signal) => !signal.announcedOnly)
            .flatMap((signal) =>
              scopedAttentionCite(signal, targetMessageIds, batches),
            ),
        ),
      ];

      return {
        model: FEEDBACK_EXTRACTION_STUB_MODEL_ID,
        signals,
        describedIncidentMessageIds,
        // Every new message in the run, because a persona declares hostility per
        // turn rather than per message: the ladder counts runs, so which of the
        // burst's messages carried the insult changes nothing it decides.
        hostileMessageIds: turn.hostileToUs ? [...targetMessageIds] : [],
        // No scripted persona asks a data-handling question — the two guests who
        // do (Νίτσα, Λούλα) are live-model guests, and the paid rehearsal runs
        // the real classifier. A scriptable field nobody scripts would be dead
        // weight; add it beside the first persona that needs it.
        policyQuestions: [],
        usage: SCRIPTED_USAGE,
        estimatedPromptTokens: 0,
      };
    } catch (error) {
      throw toScriptedError(error);
    }
  }

  private claimTurn(texts: readonly string[]): ClaimedStubTurn {
    const persona = matchPersona(this.personas, texts);
    const turnIndex = resolveStubTurnIndex(persona, texts);
    const turn = persona.stub[turnIndex];
    if (!turn) {
      throw scriptFailure(
        `Scripted burst persona ${persona.id} has no stub for message cluster ${turnIndex + 1}`,
      );
    }
    return { persona, turn, turnIndex };
  }
}

/**
 * Map new participant text to the quiet-window cluster that owns its stub turn.
 * This is deliberately exported for the corpus invariant and multi-worker
 * regression tests; production extraction never calls it.
 */
export function resolveStubTurnIndex(
  persona: BurstPersona,
  texts: readonly string[],
): number {
  const targetTexts = texts.map((text) => text.trim());
  const clusters: string[][] = [];

  for (const [messageIndex, message] of persona.messages.entries()) {
    if (
      messageIndex === 0 ||
      message.afterMs > FEEDBACK_EXTRACT_QUIET_WINDOW_MS
    ) {
      clusters.push([]);
    }
    if (message.text !== null) {
      clusters.at(-1)!.push(message.text.trim());
    }
  }

  const textClusters = clusters.filter((cluster) => cluster.length > 0);
  const matchingIndexes = textClusters.flatMap((cluster, index) =>
    targetTexts.every((text) => cluster.includes(text)) ? [index] : [],
  );

  if (matchingIndexes.length === 0) {
    throw scriptFailure(
      `Scripted burst persona ${persona.id} matched no quiet-window message cluster`,
    );
  }
  if (matchingIndexes.length > 1) {
    throw scriptFailure(
      `Scripted burst persona ${persona.id} matched multiple quiet-window message clusters`,
    );
  }
  return matchingIndexes[0]!;
}

function buildProposal(
  turn: BurstStubTurn,
  parsed: ParsedBurstExtractionPrompt,
  _persona: BurstPersona,
  questionKeys: readonly FeedbackAnswerQuestionKey[],
): FeedbackExtractionProposal {
  const confidence = turn.confidence ?? 0.9;
  // The respondent is addressable on purpose. A stub that could only name
  // candidates could not express the proposal `subject_is_respondent` exists to
  // refuse, so the rule had no rehearsal — the persona who answers «εμένα μου
  // άρεσα» would have failed on the stub's own limitation rather than on the
  // mechanism under test.
  const byName = candidateIndex(
    parsed.respondent
      ? [...parsed.candidates, parsed.respondent]
      : parsed.candidates,
  );

  const declineCite = resolveCite("all-new", parsed.newMessageIds);

  return {
    goals: feedbackExtractionGoalVerdicts(
      {
        answered: (turn.answers ?? []).map((answer) => {
          const subject = resolveSubject(answer.about, undefined, byName, {
            required:
              answer.question === "liked" ||
              answer.question === "meet_again" ||
              answer.question === "avoid",
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
        declined: (turn.skippedGoals ?? []).map((questionKey) => ({
          questionKey,
          sourceMessageIds: declineCite,
        })),
      },
      questionKeys,
    ),
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
        `Scripted burst about "${about}" is neither a ΥΠΟΨΗΦΙΟΙ candidate nor the ΣΥΝΟΜΙΛΗΤΗΣ`,
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
  const scoped = scopedAttentionCite(signal, targetMessageIds, batches);
  return signal.categories.map((category) => ({
    category,
    recommendedAction: signal.action,
    sourceMessageIds: scoped,
    confidence: 0.9,
  }));
}

/**
 * The messages one scripted signal actually cites, after batch scoping.
 *
 * Shared with the described-incident list so the two can never disagree about
 * which message a signal is on — a signal that cites the last message of a burst
 * and a description recorded against the first would send the assurance for a
 * disclosure that arrived somewhere else.
 */
function scopedAttentionCite(
  signal: BurstStubAttentionSignal,
  targetMessageIds: readonly string[],
  batches: readonly (readonly string[])[],
): string[] {
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
  return scoped;
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
    // A bodyless message (voice note, photo, reaction) never reaches a
    // transcript, so it can never identify anybody here. Matching on it would
    // mean matching every such persona against every other one's run.
    const personaTexts = new Set(
      persona.messages
        .map((message) => message.text?.trim())
        .filter((text): text is string => text !== undefined),
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
