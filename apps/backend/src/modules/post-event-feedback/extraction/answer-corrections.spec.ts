import type { FeedbackExtractionMeta } from "@join-the-six/database";
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

  it("ignores a blob that does not read as a correction", () => {
    // `extraction_meta` is an open jsonb record, so this is a parse and not a
    // cast: a shape nobody wrote through `appendAnswerCorrection` must not be
    // able to 500 the results endpoint, and must not silently freeze a row
    // against extraction either.
    const malformed: FeedbackExtractionMeta = {
      ...extracted,
      corrections: [
        "4 → 2",
        { at: "2026-07-27T10:00:00.000Z" },
        { at: 5, by: "admin-1", from: { valueInt: 4 }, to: { valueInt: 2 } },
        correction(),
      ],
    };

    expect(readAnswerCorrections(malformed)).toStrictEqual([correction()]);
    expect(
      readAnswerCorrections({ ...extracted, corrections: "nope" }),
    ).toStrictEqual([]);
    expect(isCorrectedAnswer({ ...extracted, corrections: [] })).toBe(false);
  });

  it("accepts a correction to and from no value at all", () => {
    // Slice 1 only corrects scored questions, so `from` is always a number
    // today. The reader still has to hold a null: `value_int` is null on every
    // liked / meet_again / avoid row, and a reader that refused null would
    // start dropping history the day this widens.
    const meta = appendAnswerCorrection(
      extracted,
      correction({ from: { valueInt: null }, to: { valueInt: null } }),
    );

    expect(latestAnswerCorrection(meta)?.from.valueInt).toBeNull();
    expect(isCorrectedAnswer(meta)).toBe(true);
  });
});
