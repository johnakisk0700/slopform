import type { FeedbackExtractionMeta } from "@join-the-six/database";

/**
 * An operator's correction to a recorded answer, kept on the answer row itself.
 *
 * The row is edited in place and the correction is **appended** to
 * `extraction_meta.corrections`. That keeps three things true at once with no
 * migration: readers of `feedback_answers` need no filter and cannot
 * double-count a superseded row (the uniqueness key is `NULLS NOT DISTINCT` on
 * conversation/question/subject, so a superseding row cannot coexist with the
 * row it supersedes); what the *model* proposed survives, because `model`,
 * `confidence` and `candidateIds` from the original run are left exactly where
 * they are and only this array is added; and `source_message_ids` still cites
 * the testimony the answer came from, which is honest — a correction is the
 * same testimony read differently, not new evidence.
 *
 * `audit_events` carries the same before/after and is the durable log. This
 * array is what the row can say for itself.
 */
export const FEEDBACK_ANSWER_CORRECTIONS_KEY = "corrections";

export interface FeedbackAnswerCorrection {
  /** When the operator made it. */
  readonly at: string;
  /** The acting principal, as `audit_events.actor_id` records it. */
  readonly by: string;
  readonly from: { readonly valueInt: number | null };
  readonly to: { readonly valueInt: number | null };
  readonly note?: string;
}

/**
 * Corrections on a row, newest last, ignoring anything that does not read as a
 * correction.
 *
 * `extraction_meta` is an open jsonb record, so this is a parse and not a cast:
 * a blob nobody wrote through `appendAnswerCorrection` must not be able to make
 * the results endpoint 500 on a shape it did not expect.
 */
export function readAnswerCorrections(
  extractionMeta: Readonly<Record<string, unknown>>,
): FeedbackAnswerCorrection[] {
  const raw = extractionMeta[FEEDBACK_ANSWER_CORRECTIONS_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is FeedbackAnswerCorrection =>
    isCorrectionEntry(entry),
  );
}

/**
 * Whether a human has decided this row's value.
 *
 * This is the freeze predicate: extraction refuses to overwrite a row it
 * answers `true` for, and raises `answer_revision` instead so the operator
 * adjudicates again. Deliberately the presence of *any* recorded correction,
 * not a separate flag, so the fact and its history cannot drift apart.
 */
export function isCorrectedAnswer(
  extractionMeta: Readonly<Record<string, unknown>>,
): boolean {
  return readAnswerCorrections(extractionMeta).length > 0;
}

/** The correction the read model publishes: the most recent one. */
export function latestAnswerCorrection(
  extractionMeta: Readonly<Record<string, unknown>>,
): FeedbackAnswerCorrection | null {
  const corrections = readAnswerCorrections(extractionMeta);
  return corrections.at(-1) ?? null;
}

/**
 * Appends one correction, leaving every key the extraction run wrote intact.
 *
 * Append and never overwrite: two operators correcting the same score a week
 * apart are two decisions, and the second one replacing the first would erase
 * the fact that anybody disagreed.
 */
export function appendAnswerCorrection(
  extractionMeta: FeedbackExtractionMeta,
  correction: FeedbackAnswerCorrection,
): FeedbackExtractionMeta {
  return {
    ...extractionMeta,
    [FEEDBACK_ANSWER_CORRECTIONS_KEY]: [
      ...readAnswerCorrections(extractionMeta),
      correction,
    ],
  };
}

function isCorrectionEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate["at"] === "string" &&
    typeof candidate["by"] === "string" &&
    isValueHolder(candidate["from"]) &&
    isValueHolder(candidate["to"])
  );
}

function isValueHolder(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const holder = (value as Record<string, unknown>)["valueInt"];
  return holder === null || typeof holder === "number";
}
