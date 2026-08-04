import { foldPostEventFeedbackText } from "./fold-text.js";

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
 * - a candidate also answers to his name with the final sigma dropped, because
 *   Greek declines first names on exactly that letter and «τον Τάκη» is how a
 *   Τάκης gets mentioned — see `candidateNameKeys` for why the mention side is
 *   *not* widened the same way;
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
  // The same «ου», typed by somebody mapping υ to its shape rather than to its
  // sound. It is the ordinary Greek-keyboard-in-Latin-letters habit, not a
  // typo: `y` *looks* like υ, so «Λούλα» comes out «loyla» as often as «loula».
  // Two live guests in one day's paid rehearsals wrote it that way, neither
  // resolved to the Λούλα sitting at their table, and both were asked the same
  // question again and again because of it.
  //
  // Above `y` → `i` on purpose, and that is the whole of the fix rather than a
  // tidiness. `y` → `i` is for the *other* υ, the one standing on its own; let
  // it run first and «loyla» becomes «loila», past the `oi` rule that would
  // have rescued it, and no longer the same skeleton as «loula» or «Λούλα».
  [/oy/gu, "u"],
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
 * Shortest word that may stand in for a whole person.
 *
 * Keeps initials and the articles Greek names arrive with — «ο», «η», `o`, `i`,
 * «Κώστας Π.» — from being addressable on their own.
 */
const MIN_ADDRESSABLE_PART_LENGTH = 3;

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
 * Every skeleton a candidate may be addressed by: the whole display name, and
 * each word in it.
 *
 * A display name is usually one word, because it is the participant's preferred
 * name — and there the whole name *is* the first name, which is why comparing
 * whole names worked for so long. When it holds more than one word, «μου άρεσε ο
 * Τάσος» compared a first name against «Τάσος Γαμωσταυρίδης» and resolved
 * nobody, so a directed answer was dropped for a person who was named plainly
 * and unambiguously.
 *
 * A candidate additionally answers to each key with its final `s` dropped,
 * because Greek declines first names on exactly that letter: Τάκης is «τον
 * Τάκη» the moment somebody speaks *about* him, and people write feedback the
 * way they speak. In the 2026-08-04T16-44-08Z rehearsal burst a guest wrote
 * «ton taki isws» at a table that held a Τάκης, `taki` ≠ `takis` filed his
 * answer as an unattributable note, and the guest was re-asked until he wrote
 * «ton taki re trito forea les». Both alphabets have collapsed to one Latin
 * skeleton by key time, so one dropped letter covers greeklish and Greek
 * script alike, and the guard keeps the remainder long enough to still name
 * somebody.
 *
 * The widening is deliberately one-sided. Stripping the *mention* too would
 * read every genitive as its owner — and «ο φίλος της Ελένης» is about the
 * friend, not about Ελένη, which is precisely the disclosure case where
 * attributing the sentence to her is the worst available outcome. A mention
 * must therefore still be, letter for letter, a form some candidate answers
 * to.
 *
 * This widens who we recognise, never who we choose between: the caller still
 * requires exactly one matching candidate, so two Κώστας at one table — or a
 * Τάκης and a Τάκη who are different people — go on resolving to nobody.
 */
function candidateNameKeys(displayName: string): readonly string[] {
  const keys = new Set<string>();
  const whole = foldPostEventFeedbackName(displayName);
  if (whole.length > 0) {
    keys.add(whole);
  }
  for (const part of displayName.split(/\s+/u)) {
    const folded = foldPostEventFeedbackName(part);
    if (folded.length >= MIN_ADDRESSABLE_PART_LENGTH) {
      keys.add(folded);
    }
  }
  for (const key of [...keys]) {
    if (key.length > MIN_ADDRESSABLE_PART_LENGTH && key.endsWith("s")) {
      keys.add(key.slice(0, -1));
    }
  }
  return [...keys];
}

/**
 * Every skeleton a mention may be compared by: the whole string, and each word
 * in it that is long enough to name somebody.
 *
 * Prompt rule 4β tells the model to echo a mentioned name exactly as the
 * participant wrote it, so «η Μαρη μου αρεσε» arrives with the article
 * attached. Folding the whole string glues article to name («imari») and
 * resolves to nobody while «Μαρη» alone would have matched — the same failure
 * mode as comparing only whole display names before first names were widened on
 * the candidate side.
 */
function mentionedNameKeys(mentionedName: string): readonly string[] {
  const keys = new Set<string>();
  const whole = foldPostEventFeedbackName(mentionedName);
  if (whole.length > 0) {
    keys.add(whole);
  }
  for (const part of mentionedName.split(/\s+/u)) {
    const folded = foldPostEventFeedbackName(part);
    if (folded.length >= MIN_ADDRESSABLE_PART_LENGTH) {
      keys.add(folded);
    }
  }
  return [...keys];
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
  const mentionKeys = mentionedNameKeys(mentionedName ?? "");
  if (mentionKeys.length === 0) {
    return undefined;
  }

  const matches = candidates.filter((candidate) => {
    const keys = candidateNameKeys(candidate.displayName);
    return mentionKeys.some((mentionKey) => keys.includes(mentionKey));
  });
  return matches.length === 1 ? matches[0] : undefined;
}
