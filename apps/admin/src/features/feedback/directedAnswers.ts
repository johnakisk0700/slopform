import type { FeedbackTone } from "./labels";

/**
 * The person-valued questions across all supported questionnaire versions, and
 * the rules for reading and changing them as a group.
 *
 * `answerCorrections.ts` next door is about one recorded answer — may this
 * number be edited, may this row be withdrawn. This module is about the shape
 * the directed answers take together: who is under each of them, which of them
 * can hold the same person at once, and who is left to add. V2 asks only
 * `meet_again` and `avoid`; `liked` remains here for valid V1 history.
 *
 * React-free and generated-client-free, like every other module in this folder,
 * so the rules are testable without a renderer. Only the fields the rules read
 * are typed here; the backend re-checks all of it.
 */

/** V1 display order; V2 omits the historical `liked` key. */
export const DIRECTED_QUESTION_KEYS = ["liked", "meet_again", "avoid"] as const;

export type DirectedQuestionKey = (typeof DIRECTED_QUESTION_KEYS)[number];

export function isDirectedQuestion(key: string): key is DirectedQuestionKey {
  return (DIRECTED_QUESTION_KEYS as readonly string[]).includes(key);
}

/**
 * One tone per directed question, so the three groups are told apart before a
 * word is read.
 *
 * They are not decoration: each tone separates a kind of seating signal. A
 * no-rematch preference is operational feedback, not evidence of misconduct,
 * so it uses warning rather than the danger tone reserved for failures and
 * safety concerns. Colour is never the only signal — each group keeps its own
 * heading and its own glyph.
 */
const DIRECTED_QUESTION_TONES: Record<DirectedQuestionKey, FeedbackTone> = {
  liked: "success",
  meet_again: "info",
  avoid: "warning",
};

export function directedQuestionTone(key: DirectedQuestionKey): FeedbackTone {
  return DIRECTED_QUESTION_TONES[key];
}

/**
 * The questions about one person that recording this one contradicts.
 *
 * Mirrors `contradictedPostEventFeedbackQuestionKeys` in the backend, which is
 * what actually performs the move. The `liked` branch is V1 compatibility: on
 * a V1 campaign, recording `avoid` can still supersede its historical positive
 * edge. V2 uses the same `avoid` key but has no `liked` goal. The admin has to
 * say what confirming will do before it happens.
 */
export function contradictedQuestionKeys(
  key: DirectedQuestionKey,
): readonly DirectedQuestionKey[] {
  if (key === "avoid") {
    return ["liked", "meet_again"];
  }
  return ["avoid"];
}

interface DirectedAnswer {
  readonly questionKey: string;
  readonly subjectParticipantId: string | null;
}

interface Candidate {
  readonly participantId: string;
  readonly displayName: string;
}

export interface AnswerCandidateChoice {
  readonly participantId: string;
  readonly displayName: string;
  /**
   * Every question this person is recorded under today that adding them here
   * would take them out of, empty when nothing moves. A list rather than one
   * key because a V1 campaign can hold both `liked` and `meet_again` for the
   * same person, and a no-rematch clears both: naming one would understate what
   * confirming costs. The picker shows them on the option, because a move is
   * not what an operator pressing «+» is expecting.
   */
  readonly movesFrom: readonly DirectedQuestionKey[];
}

/**
 * Who is left to record under one question.
 *
 * Anybody already under it is dropped — they are on screen, and the backend
 * would answer with the row that is already there. Everybody else stays,
 * including the people a move would take from another question: hiding them
 * would leave an operator hunting for a name that is present at the event, with
 * nothing saying why it is missing. What the option carries instead is what
 * choosing it would cost.
 */
export function answerCandidateChoices(
  candidates: readonly Candidate[],
  answers: readonly DirectedAnswer[],
  questionKey: DirectedQuestionKey,
): readonly AnswerCandidateChoice[] {
  const contradicted = contradictedQuestionKeys(questionKey);

  return candidates
    .filter(
      (candidate) =>
        !answers.some(
          (answer) =>
            answer.questionKey === questionKey &&
            answer.subjectParticipantId === candidate.participantId,
        ),
    )
    .map((candidate) => ({
      participantId: candidate.participantId,
      displayName: candidate.displayName,
      // In the questions' own order, so «Liked and Meet again» never comes out
      // the other way round on one option and this way on the next.
      movesFrom: contradicted.filter((key) =>
        answers.some(
          (answer) =>
            answer.subjectParticipantId === candidate.participantId &&
            answer.questionKey === key,
        ),
      ),
    }));
}

/**
 * What confirming will actually do, in plain words.
 *
 * Two sentences at most, and the second one exists only when something else
 * changes: an answer that quietly deleted another answer is exactly the
 * surprise this screen must not spring. It also says the row is recorded as
 * staff-written, because a reader a month later must not take it for something
 * the participant said.
 */
export function recordAnswerDescription(input: {
  readonly questionLabel: string;
  readonly subjectLabel: string;
  readonly movesFromLabels: readonly string[];
}): string {
  const recorded = `Records ${input.subjectLabel} under «${input.questionLabel}» as your own answer, labelled as staff-written. No message is sent.`;
  if (input.movesFromLabels.length === 0) {
    return recorded;
  }
  const moved = input.movesFromLabels
    .map((label) => `«${label}»`)
    .join(" and ");
  const plural = input.movesFromLabels.length > 1;
  return `${recorded} ${input.subjectLabel} is currently under ${moved} — the questionnaire treats ${plural ? "those" : "that"} as incompatible with this seating preference, so ${plural ? "those answers are" : "that answer is"} withdrawn in the same step.`;
}
