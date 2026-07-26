import { foldPostEventFeedbackText } from "./post-event-feedback-stop-matcher.js";

/**
 * Resolving a name somebody typed to a candidate, across the two alphabets
 * Greek WhatsApp is actually written in.
 *
 * A large minority of Greek users type Latin characters, and «o nikos gamatos»
 * is an ordinary sentence, not an edge case. Comparing raw strings meant
 * «Nikos» matched nothing, the directed answer degraded to a subjectless note,
 * and everything that person said about a real participant was filed as
 * unattributable.
 *
 * The match is deliberately narrow, because the cost of getting it wrong is
 * attributing an opinion to the wrong person:
 *
 * - both sides collapse to the same lossy **skeleton**, so the many ways to
 *   transliterate one sound stop mattering (ι/η/υ/ει/οι all become `i`, ο/ω
 *   both `o`, χ may be written `x`, `h` or `ch`);
 * - a name resolves only when it matches **exactly one** candidate. Two Κώστας
 *   at the same table is the ordinary case, not a rare one, and a coin flip
 *   between them is worse than admitting we do not know.
 */

/** Two-character sequences resolved before single letters. */
const GREEK_DIGRAPHS: readonly (readonly [string, string])[] = [
  ["θ", "th"],
  ["ξ", "ks"],
  ["ψ", "ps"],
  ["ου", "u"],
  ["μπ", "b"],
  ["ντ", "d"],
  ["γκ", "g"],
  ["γγ", "g"],
  ["τσ", "ts"],
  ["τζ", "tz"],
  ["αι", "e"],
  ["ει", "i"],
  ["οι", "i"],
  ["υι", "i"],
  ["αυ", "av"],
  ["ευ", "ev"],
];

const GREEK_LETTERS: Readonly<Record<string, string>> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "i",
  φ: "f",
  χ: "x",
  ω: "o",
};

/**
 * Latin spellings of the same sounds, applied after the Greek pass so both
 * alphabets land on one form. Order matters: digraphs before single letters.
 */
const LATIN_EQUIVALENTS: readonly (readonly [RegExp, string])[] = [
  [/ch/gu, "x"],
  [/th/gu, "th"],
  [/ps/gu, "ps"],
  [/mp/gu, "b"],
  [/nt/gu, "d"],
  [/gk/gu, "g"],
  [/ou/gu, "u"],
  [/ai/gu, "e"],
  [/ei/gu, "i"],
  [/oi/gu, "i"],
  [/y/gu, "i"],
  [/j/gu, "i"],
  // A bare `h`, once `ch`/`th` are gone, is how η gets typed — «Dhmhtra». χ is
  // written `x` or `ch` instead, so reading a lone `h` as χ would only turn
  // Δήμητρα into a name nobody has.
  [/h/gu, "i"],
  [/w/gu, "o"],
  [/c/gu, "k"],
  [/q/gu, "k"],
  [/b/gu, "v"],
  [/u/gu, "i"],
];

/**
 * The alphabet-independent skeleton of a name. Not reversible and not meant to
 * be: its only job is to make two spellings of one name compare equal.
 */
export function foldPostEventFeedbackName(name: string): string {
  let folded = foldPostEventFeedbackText(name).replaceAll(" ", "");
  for (const [greek, latin] of GREEK_DIGRAPHS) {
    folded = folded.replaceAll(greek, latin);
  }
  folded = [...folded]
    .map((character) => GREEK_LETTERS[character] ?? character)
    .join("");
  for (const [pattern, replacement] of LATIN_EQUIVALENTS) {
    folded = folded.replace(pattern, replacement);
  }
  // Doubled letters carry no sound in either script: «Κωσταs» / «Kostass».
  return folded.replaceAll(/(.)\1+/gu, "$1");
}

export interface PostEventFeedbackNameCandidate {
  readonly participantId: string;
  readonly displayName: string;
}

/**
 * The single candidate a mentioned name resolves to, or `undefined`.
 *
 * `undefined` covers both "nobody" and "more than one", which the caller must
 * treat identically: D18 degrades rather than guesses, and a name shared by two
 * people at the table is exactly when guessing is most tempting and most wrong.
 */
export function resolvePostEventFeedbackCandidateByName(
  mentionedName: string | null | undefined,
  candidates: readonly PostEventFeedbackNameCandidate[],
): PostEventFeedbackNameCandidate | undefined {
  const folded = foldPostEventFeedbackName(mentionedName ?? "");
  if (folded.length === 0) {
    return undefined;
  }

  const matches = candidates.filter(
    (candidate) => foldPostEventFeedbackName(candidate.displayName) === folded,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
