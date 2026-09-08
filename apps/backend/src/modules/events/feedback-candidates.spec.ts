import { describe, expect, it } from "vitest";

import { selectFeedbackCandidates } from "./feedback-candidates.js";

describe("feedback candidates (D16)", () => {
  const attendees = [
    {
      participantId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      present: true,
      displayName: "Roula",
    },
    {
      participantId: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      present: true,
      displayName: "Kostas",
    },
    {
      participantId: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      present: false,
      displayName: "Absent",
    },
  ] as const;

  it("includes present attendees and excludes the respondent", () => {
    const selected = selectFeedbackCandidates(
      attendees,
      "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    );

    expect(selected.map((entry) => entry.participantId)).toEqual([
      "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    ]);
  });
});
