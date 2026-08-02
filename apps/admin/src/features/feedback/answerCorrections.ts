import { formatDateTime } from "../../lib/dateTime";

/**
 * The two things an operator can do about an answer the model got wrong, as
 * rules rather than as JSX.
 *
 * They are different operations because they are different assertions. A wrong
 * **score** keeps the claim and changes its magnitude: the participant did rate
 * the evening, we wrote down the wrong number. A wrong **person** is a claim
 * about somebody who was never named, and there is no right number for it — the
 * row should stop existing.
 *
 * Only the fields these rules read are typed here, so they can be exercised
 * without the generated client. The backend re-checks both: the admin decides
 * what to offer, never what is allowed.
 */
export interface CorrectableAnswer {
  readonly questionKey: string;
  readonly valueInt: number | null;
  readonly subjectParticipantId: string | null;
  readonly correction: { readonly at: string; readonly by: string } | null;
}

/** The whole range the question set allows for a score. */
export const FEEDBACK_SCORE_CHOICES = [1, 2, 3, 4, 5] as const;

/**
 * Questions whose answer is a number.
 *
 * Mirrors `valueKind: "int"` in the V2 question set. All four experience
 * dimensions use the same 1–5 scale. On the person-valued questions the
 * subject *is* the answer and `valueInt` is null, so there is no number to edit
 * — offering a score picker there would assert something the question cannot
 * express.
 */
const SCORED_QUESTION_KEYS: readonly string[] = [
  "event_score",
  "table_fit",
  "participation_ease",
  "conversation_balance",
];

export function canCorrectAnswerValue(answer: CorrectableAnswer): boolean {
  return SCORED_QUESTION_KEYS.includes(answer.questionKey);
}

/**
 * Whether this answer can be withdrawn from the panel.
 *
 * A directed answer only: this is the wrong-person case, and it is the one an
 * operator can act on without a way to re-aim the row at the right person.
 */
export function canWithdrawAnswer(answer: CorrectableAnswer): boolean {
  return answer.subjectParticipantId !== null;
}

/**
 * The line that says a human decided this value.
 *
 * `createdAt` stops meaning "when this value was decided" the moment a
 * correction lands, so a corrected number without this line is a number with no
 * author. Returns null for a row no operator has touched — the ordinary case
 * must stay silent.
 */
export function correctionSummary(answer: CorrectableAnswer): string | null {
  const correction = answer.correction;
  if (!correction) {
    return null;
  }
  return `Corrected by ${correction.by} · ${formatDateTime(correction.at)}`;
}

/**
 * What withdrawing this answer will actually do, for the confirmation dialog.
 *
 * It names the person and the question, because that pair is the assertion being
 * withdrawn, and it says the deletion is not reversible from this screen — the
 * row is gone and only the audit log remembers it.
 */
export function withdrawalDescription(
  questionLabel: string,
  subjectLabel: string,
): string {
  return `Removes the recorded «${questionLabel}» answer about ${subjectLabel}. Use this when the answer is about the wrong person. It cannot be undone here, and no message is sent.`;
}
