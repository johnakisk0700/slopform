import { describe, expect, it } from "vitest";

import { foldGreekAccents, foldPostEventFeedbackText } from "./fold-text.js";
import { matchesPostEventFeedbackStopCommand } from "./stop-command.js";

describe("post-event feedback STOP matcher", () => {
  it("matches English commands case- and whitespace-insensitively", () => {
    expect(matchesPostEventFeedbackStopCommand("STOP")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("stop")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("  StOp   ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("STOP ALL")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand(" stop   all ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("UnSuBsCrIbE")).toBe(true);
  });

  it("matches Greek commands with accent and case folding", () => {
    expect(matchesPostEventFeedbackStopCommand("ΣΤΟΠ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("στοπ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("  Στοπ  ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("ΔΙΑΚΟΠΗ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("διακοπή")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("Διάκοπη")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("  διά  κοπή  ")).toBe(false);
  });

  it("matches a command however it is punctuated", () => {
    // The old matcher compared whole strings without folding punctuation, so
    // every one of these left the conversation open, the opt-in true and the
    // reminder planner armed. An exclamation mark is how an annoyed person types
    // it.
    expect(matchesPostEventFeedbackStopCommand("ΣΤΟΠ!")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("stop.")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("STOP!!!")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("Στοπ...")).toBe(true);
  });

  it("matches a command softened with politeness", () => {
    expect(matchesPostEventFeedbackStopCommand("Στοπ ευχαριστώ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("ΣΤΟΠ, παρακαλώ")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("stop please")).toBe(true);
    expect(matchesPostEventFeedbackStopCommand("σταματήστε")).toBe(true);
  });

  it("matches a plain-language opt-out that opens the message", () => {
    expect(
      matchesPostEventFeedbackStopCommand("μη μου ξαναστείλετε μηνύματα"),
    ).toBe(true);
    expect(
      matchesPostEventFeedbackStopCommand(
        "Μην μου ξαναστείλετε μηνύματα παρακαλώ",
      ),
    ).toBe(true);
    expect(
      matchesPostEventFeedbackStopCommand("δεν θέλω άλλα μηνύματα ευχαριστώ"),
    ).toBe(true);
    expect(
      matchesPostEventFeedbackStopCommand("stop na mou stelnete minimata"),
    ).toBe(true);
  });

  it("rejects partial matches and ordinary feedback text", () => {
    expect(matchesPostEventFeedbackStopCommand("please stop talking")).toBe(
      false,
    );
    expect(matchesPostEventFeedbackStopCommand("σταμάτα")).toBe(false);
    expect(matchesPostEventFeedbackStopCommand("4")).toBe(false);
    expect(matchesPostEventFeedbackStopCommand("")).toBe(false);
    // The intro copy ends «γράψε ΣΤΟΠ.». Quoting it back is not an opt-out,
    // which is why a *command* must still be the whole message.
    expect(
      matchesPostEventFeedbackStopCommand(
        "Γεια! Αν δεν θες μηνύματα, γράψε ΣΤΟΠ.",
      ),
    ).toBe(false);
  });

  it("finds a plain-language opt-out that follows an answer", () => {
    // How people actually withdraw consent: they answer the question first and
    // then ask to be left alone, in one message. Reading only the head of it
    // filed the second half as testimony about the evening.
    expect(
      matchesPostEventFeedbackStopCommand(
        "5 πάντως. μη μου ξαναστείλετε μηνύματα παρακαλώ",
      ),
    ).toBe(true);
    expect(
      matchesPostEventFeedbackStopCommand(
        "ωραία ήταν, αλλά δεν θέλω άλλα μηνύματα",
      ),
    ).toBe(true);
    expect(
      matchesPostEventFeedbackStopCommand("thanks but no more messages please"),
    ).toBe(true);
  });

  it("does not mistake an objection to a question for an opt-out", () => {
    // The boundary the phrase list has to hold: these are about the
    // questionnaire's content, not about being messaged at all.
    expect(
      matchesPostEventFeedbackStopCommand("σταμάτα να ρωτάς για τον Νίκο"),
    ).toBe(false);
    expect(
      matchesPostEventFeedbackStopCommand(
        "σταματήστε να ρωτάτε για τον Κώστα, δεν θέλω να μιλήσω γι' αυτόν",
      ),
    ).toBe(false);
    expect(
      matchesPostEventFeedbackStopCommand("ο Νίκος δεν σταματούσε να μιλάει"),
    ).toBe(false);
  });

  it("normalizes whitespace, punctuation and Greek accents deterministically", () => {
    expect(foldPostEventFeedbackText("  STOP   ALL  ")).toBe("stop all");
    expect(foldPostEventFeedbackText("Διάκοπή!")).toBe("διακοπη");
    expect(foldGreekAccents("άέήίόύώΐΰ")).toBe("αεηιουωιυ");
  });
});
