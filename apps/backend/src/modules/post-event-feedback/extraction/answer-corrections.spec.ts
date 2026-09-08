import type { FeedbackExtractionMeta } from "@slopform/database";
import { describe, expect, it } from "vitest";

import {
  appendAnswerCorrection,
  isCorrectedAnswer,
  latestAnswerCorrection,
  readAnswerCorrections,
  type FeedbackAnswerCorrection,
} from "./answer-corrections.js";

const extracted: FeedbackExtractionMeta = {
  model: "google/gemini-3.6-flash",
  confidence: 0.82,
  candidateIds: ["p-nikos", "p-eleni"],
};

function correction(
  overrides: Partial<FeedbackAnswerCorrection> = {},
): FeedbackAnswerCorrection {
  return {
    at: "2026-07-27T10:00:00.000Z",
    by: "admin-1",
    from: { valueInt: 4 },
    to: { valueInt: 2 },
    ...overrides,
  };
}

describe("answer corrections on extraction_meta", () => {
  it("keeps what the model proposed beside what the operator decided", () => {
    const meta = appendAnswerCorrection(extracted, correction());

    // The whole argument for editing in place: the row still says which model
    // read the conversation, how sure it was and which candidates it could
    // choose from. A superseding row would have kept that too — and cost a
    // migration, a partial unique index and a filter every reader must
    // remember.
    expect(meta.model).toBe("google/gemini-3.6-flash");
    expect(meta.confidence).toBe(0.82);
    expect(meta.candidateIds).toStrictEqual(["p-nikos", "p-eleni"]);
    expect(readAnswerCorrections(meta)).toStrictEqual([correction()]);
  });

  it("appends rather than overwrites, and publishes the newest", () => {
    const second = correction({
      at: "2026-08-01T09:30:00.000Z",
      by: "admin-2",
      from: { valueInt: 2 },
      to: { valueInt: 3 },
      note: "Ξαναδιάβασα τη συζήτηση",
    });
    const meta = appendAnswerCorrection(
      appendAnswerCorrection(extracted, correction()),
      second,
    );

    // Two operators disagreeing a week apart are two decisions. Replacing the
    // first would erase the fact that anybody ever disagreed.
    expect(readAnswerCorrections(meta)).toHaveLength(2);
    expect(latestAnswerCorrection(meta)).toStrictEqual(second);
  });

  it("reads an untouched row as uncorrected, and never freezes it by accident", () => {
    expect(isCorrectedAnswer(extracted)).toBe(false);
    expect(latestAnswerCorrection(extracted)).toBeNull();
    expect(
      isCorrectedAnswer(appendAnswerCorrection(extracted, correction())),
    ).toBe(true);
  });
});
