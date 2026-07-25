import {
  foldPostEventFeedbackText,
  foldedTextContainsAtWordStart,
} from "./post-event-feedback-stop-matcher.js";

/**
 * The deterministic safety tripwire (D13, amended).
 *
 * This is a WP0-style pure matcher, not a classifier and not a filter. It never
 * suppresses extraction, never forces a handoff and never writes a separate
 * incident record: the turn continues into the normal pipeline and the
 * disclosure becomes an ordinary, visible note. All this match does is raise
 * `needsAttention` and record one audit event, so an operator sees the
 * conversation instead of discovering it later.
 *
 * Because the only cost of a match is an operator's attention, the lexicon is
 * tuned for **precision over recall**: obvious explicit terms only. The model
 * remains the instrument that understands context; this is the floor that
 * survives a provider refusal.
 */

export const POST_EVENT_FEEDBACK_SAFETY_CATEGORIES = [
  "sexual_content",
  "harassment",
  "violence",
  "self_harm",
] as const;

export type PostEventFeedbackSafetyCategory =
  (typeof POST_EVENT_FEEDBACK_SAFETY_CATEGORIES)[number];

export interface PostEventFeedbackSafetyLexiconEntry {
  readonly category: PostEventFeedbackSafetyCategory;
  /**
   * Terms are stored already folded (accents removed, lower case, single
   * spaces) so the matcher never has to normalise the lexicon at run time and a
   * reviewer reads exactly what is compared. Matching semantics are
   * `foldedTextContainsAtWordStart`: word-start anchored, open on the right.
   */
  readonly terms: readonly string[];
}

/**
 * Editable data, deliberately: adding a term is a product/safety decision, not
 * a code change, and every term here should be defensible on its own.
 */
export const POST_EVENT_FEEDBACK_SAFETY_LEXICON = [
  {
    category: "sexual_content",
    terms: ["dickpic", "dick pic", "nude", "sexting", "πουτσ", "μουνι", "καυλ"],
  },
  {
    category: "harassment",
    terms: [
      "harass",
      "molest",
      "grope",
      "rape",
      "παρενοχλ",
      "ασελγ",
      "βιασμ",
      "χουφτ",
      "εκβιασ",
    ],
  },
  {
    category: "violence",
    terms: [
      "assault",
      "violence",
      "violent",
      "threaten",
      "ξυλοδαρμ",
      "απειλησ",
    ],
  },
  {
    category: "self_harm",
    terms: [
      "suicid",
      "kill myself",
      "self harm",
      "selfharm",
      "αυτοκτον",
      "αυτοτραυματ",
    ],
  },
] as const satisfies readonly PostEventFeedbackSafetyLexiconEntry[];

export interface PostEventFeedbackSafetyMatch {
  readonly matched: boolean;
  /** Bounded vocabulary, safe to audit — it describes the class, not the text. */
  readonly categories: readonly PostEventFeedbackSafetyCategory[];
}

export function matchPostEventFeedbackSafetyTerms(
  text: string,
): PostEventFeedbackSafetyMatch {
  const folded = foldPostEventFeedbackText(text);
  if (folded.length === 0) {
    return { matched: false, categories: [] };
  }

  const categories: PostEventFeedbackSafetyCategory[] = [];
  for (const entry of POST_EVENT_FEEDBACK_SAFETY_LEXICON) {
    if (
      entry.terms.some((term) => foldedTextContainsAtWordStart(folded, term))
    ) {
      categories.push(entry.category);
    }
  }

  return { matched: categories.length > 0, categories };
}

export function matchesPostEventFeedbackSafetyTerm(text: string): boolean {
  return matchPostEventFeedbackSafetyTerms(text).matched;
}
