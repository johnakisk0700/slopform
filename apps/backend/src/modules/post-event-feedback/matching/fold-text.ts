export function foldGreekAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * The shared comparison form for matching *inside* free text: accents folded,
 * lower case, and every run of non-alphanumeric characters reduced to a single
 * space.
 *
 * Collapsing punctuation is what makes `dick-pic`, `dick pic` and `dick.pic`
 * one input, and what lets a matcher test word starts by looking for a space
 * instead of carrying a Unicode boundary regex.
 *
 * The STOP matcher uses it too. It once did not, on the reasoning that stripping
 * punctuation would widen the command rather than normalise it — and the result
 * was that `ΣΤΟΠ!`, `stop.` and `STOP!!!` all failed to stop anything while the
 * reminder planner stayed armed. An exclamation mark is how an annoyed person
 * types it; the folded form is the only honest comparison.
 */
export function foldPostEventFeedbackText(text: string): string {
  return foldGreekAccents(text)
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Left-anchored containment over folded text: `term` must begin a word but may
 * be followed by anything.
 *
 * Greek inflects on the suffix, so an open right edge lets one stem cover a
 * whole paradigm («βιασμ» → βιασμός, βιασμού, βιασμοί) and lets a given name
 * match its vocative. A closed left edge is what keeps `rape` out of «grape»
 * and «βιασμ» out of «εκβιασμός».
 */
export function foldedTextContainsAtWordStart(
  foldedText: string,
  foldedTerm: string,
): boolean {
  if (foldedTerm.length === 0) {
    return false;
  }
  let index = foldedText.indexOf(foldedTerm);
  while (index !== -1) {
    if (index === 0 || foldedText[index - 1] === " ") {
      return true;
    }
    index = foldedText.indexOf(foldedTerm, index + 1);
  }
  return false;
}
