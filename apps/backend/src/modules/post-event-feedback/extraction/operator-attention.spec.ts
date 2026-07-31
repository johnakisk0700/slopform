import { describe, expect, it } from "vitest";

import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import { operatorAttentionRaises } from "./operator-attention.js";

/**
 * The raises, read as an operator's queue rather than as a list of code paths.
 *
 * The rest of this function is covered where it is produced — by the loop
 * scenarios, which assert the badge and the alert a whole conversation earns.
 * What is here is the one raise those scenarios cannot see the *name* of: the
 * outcome snapshot exposes `needsAttention` and the flagged messages, not the
 * reason vocabulary, and «which reason» is the entire point of having one.
 */

function validated(
  overrides: Partial<FeedbackExtractionValidationResult> = {},
): FeedbackExtractionValidationResult {
  return {
    answers: [],
    notes: [],
    skippedGoals: [],
    nextGoal: "liked",
    reply: "Τέλεια, το σημείωσα!",
    replySuppressedReason: null,
    safetySignals: [],
    handoff: false,
    confidence: 0.9,
    rejections: [],
    conflictingAnswerRevision: false,
    ...overrides,
  };
}

describe("operatorAttentionRaises", () => {
  it("says the questionnaire is unfinished when the re-ask cap withheld the only wording left", () => {
    // The bot has stopped asking a question nobody has answered, which is what
    // `unfinished_questionnaire` means in the vocabulary — the same job as a
    // withdrawal's, arrived at by a different route. Nothing else was true of
    // this run, so it is the only row.
    expect(
      operatorAttentionRaises(
        validated(),
        "m-participant-7",
        false,
        "none",
        "m-bot-4",
      ),
    ).toEqual([{ kind: "unfinished_questionnaire", messageId: "m-bot-4" }]);
  });

  it("anchors the stall on the bot's message, not on the newest thing the participant typed", () => {
    // Recorded once rather than once per run. `raiseAttention` dedupes on kind
    // plus message, and the participant is still typing — every turn brings a
    // new message id, so an anchor taken from the testimony would file the same
    // reason again for as long as they kept going.
    const first = operatorAttentionRaises(
      validated(),
      "m-participant-7",
      false,
      "none",
      "m-bot-4",
    );
    const later = operatorAttentionRaises(
      validated(),
      "m-participant-9",
      false,
      "none",
      "m-bot-4",
    );

    expect(later).toEqual(first);
  });

  it("raises nothing about the questionnaire on an ordinary run", () => {
    expect(operatorAttentionRaises(validated(), "m-participant-7")).toEqual([]);
  });
});
