import { describe, expect, it } from "vitest";

import {
  isFeedbackCandidateAttendee,
  selectFeedbackCandidates,
} from "./feedback-candidates.js";

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

  it("excludes absent attendees even when they are not the respondent", () => {
    expect(
      isFeedbackCandidateAttendee(
        attendees[2],
        "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      ),
    ).toBe(false);
  });

  it("never treats the respondent as their own candidate", () => {
    expect(
      isFeedbackCandidateAttendee(
        attendees[0],
        "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      ),
    ).toBe(false);
  });
});
