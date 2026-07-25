import { describe, expect, it } from "vitest";

import {
  foldGreekAccents,
  matchesPostEventFeedbackStopCommand,
  normalizePostEventFeedbackStopInput,
} from "./post-event-feedback-stop-matcher.js";

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

  it("rejects partial matches and ordinary feedback text", () => {
    expect(matchesPostEventFeedbackStopCommand("please stop talking")).toBe(
      false,
    );
    expect(matchesPostEventFeedbackStopCommand("σταμάτα")).toBe(false);
    expect(matchesPostEventFeedbackStopCommand("4")).toBe(false);
    expect(matchesPostEventFeedbackStopCommand("")).toBe(false);
    expect(
      matchesPostEventFeedbackStopCommand(
        "Γεια! Αν δεν θες μηνύματα, γράψε ΣΤΟΠ.",
      ),
    ).toBe(false);
  });

  it("normalizes whitespace and folds Greek accents deterministically", () => {
    expect(normalizePostEventFeedbackStopInput("  STOP   ALL  ")).toBe(
      "stop all",
    );
    expect(normalizePostEventFeedbackStopInput("Διάκοπή")).toBe("διακοπη");
    expect(foldGreekAccents("άέήίόύώΐΰ")).toBe("αεηιουωιυ");
  });
});
