import type { FeedbackExtractionMeta } from "@slopform/database";

/**
 * Operator corrections appended on the answer row.
 *
 * Edit in place and append `extraction_meta.corrections`: uniqueness stays
 * `NULLS NOT DISTINCT` on conversation/question/subject (no second row), the
 * original `model` / `confidence` / `candidateIds` stay, and
 * `source_message_ids` still cites the same testimony. `audit_events` is the
 * durable before/after log.
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
 * Corrections on a row, newest last. Parses open jsonb — a foreign blob must
 * not 500 the results endpoint.
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
 * Freeze predicate: any recorded correction blocks overwrite; extraction
 * raises `answer_revision` instead. Presence of the array is the flag.
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

/** Appends one correction; never overwrites earlier decisions or run metadata. */
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
