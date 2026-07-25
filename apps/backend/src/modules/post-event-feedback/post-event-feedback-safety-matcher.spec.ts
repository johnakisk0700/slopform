import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_SAFETY_LEXICON,
  matchPostEventFeedbackSafetyTerms,
  matchesPostEventFeedbackSafetyTerm,
} from "./post-event-feedback-safety-matcher.js";
import {
  foldedTextContainsAtWordStart,
  matchesPostEventFeedbackStopCommand,
} from "./post-event-feedback-stop-matcher.js";

describe("post-event feedback safety matcher", () => {
  it("matches the acceptance-run disclosure that made the model refuse", () => {
    const match = matchPostEventFeedbackSafetyTerms(
      "Ο Γιώργος μας έδειχνε dickpics όλο το βράδυ",
    );

    expect(match.matched).toBe(true);
    expect(match.categories).toEqual(["sexual_content"]);
  });

  it.each([
    ["Μας παρενόχλησε", "παρενόχλησε accented"],
    ["ΜΑΣ ΠΑΡΕΝΟΧΛΗΣΕ", "upper case"],
    ["μας παρενοχλησε", "already folded"],
    ["Μιλάμε για παρενόχληση.", "trailing punctuation"],
  ])("folds accents and case: %s (%s)", (text) => {
    expect(matchesPostEventFeedbackSafetyTerm(text)).toBe(true);
  });

  it("covers a Greek stem's whole inflection from one entry", () => {
    for (const text of ["βιασμός", "βιασμού", "βιασμοί", "για βιασμό"]) {
      expect(matchesPostEventFeedbackSafetyTerm(text)).toBe(true);
    }
  });

  it("treats punctuation between words as a separator", () => {
    expect(matchesPostEventFeedbackSafetyTerm("he sent a dick-pic")).toBe(true);
    expect(matchesPostEventFeedbackSafetyTerm("he sent a dick.pic")).toBe(true);
  });

  it("reports every matching category, deduplicated and ordered", () => {
    const match = matchPostEventFeedbackSafetyTerms(
      "Με απείλησε και μιλούσε για αυτοκτονία",
    );

    expect(match.categories).toEqual(["violence", "self_harm"]);
  });

  describe("precision: a term must begin a word", () => {
    it.each([
      ["Φάγαμε grape και ήταν ωραία", "grape does not contain rape"],
      ["Το scrape του σάιτ", "scrape does not contain rape"],
      ["Καλή βραδιά, ωραία παρέα", "ordinary praise"],
      ["Το φαγητό ήταν μέτριο", "ordinary complaint"],
      ["Βιασύνη στο σερβίρισμα", "βιασυνη is not the βιασμ stem"],
      ["", "empty"],
      ["   ", "whitespace only"],
    ])("does not fire on %s (%s)", (text) => {
      expect(matchesPostEventFeedbackSafetyTerm(text)).toBe(false);
    });

    it("matches εκβιασμός through its own entry, never through the βιασμ stem", () => {
      const match = matchPostEventFeedbackSafetyTerms("Έγινε εκβιασμός");
      expect(match.categories).toEqual(["harassment"]);

      // The stem is present as a substring but not at a word start, which is
      // exactly the containment rule that keeps `rape` out of «grape».
      expect(foldedTextContainsAtWordStart("εγινε εκβιασμος", "βιασμ")).toBe(
        false,
      );
      expect(foldedTextContainsAtWordStart("εγινε εκβιασμος", "εκβιασ")).toBe(
        true,
      );
      expect(foldedTextContainsAtWordStart("φαγαμε grape", "rape")).toBe(false);
    });
  });

  it("keeps the lexicon stored in its own folded comparison form", () => {
    // A term that needs folding at match time would silently never match, so
    // the invariant is asserted rather than trusted.
    for (const entry of POST_EVENT_FEEDBACK_SAFETY_LEXICON) {
      for (const term of entry.terms) {
        expect(term).toBe(term.normalize("NFD").replace(/\p{M}/gu, ""));
        expect(term).toBe(term.toLowerCase().trim());
        expect(term).not.toMatch(/\s{2,}/u);
      }
    }
  });

  it("is orthogonal to the STOP matcher: a bare STOP is not safety content", () => {
    expect(matchesPostEventFeedbackStopCommand("ΣΤΟΠ")).toBe(true);
    expect(matchesPostEventFeedbackSafetyTerm("ΣΤΟΠ")).toBe(false);
  });
});
