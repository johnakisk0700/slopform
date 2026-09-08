import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  POST_EVENT_FEEDBACK_QUESTION_SET_V2,
  UnsupportedPostEventFeedbackQuestionSetVersionError,
  contradictedPostEventFeedbackQuestionKeys,
  getPostEventFeedbackQuestionSet,
  resolveCampaignCopy,
} from "./question-set.js";

describe("post-event feedback versioned question sets", () => {
  it("uses the persisted version for fallback while preserving stored copy", () => {
    expect(
      resolveCampaignCopy(
        { questionSetVersion: 1, copy: { event_score: "Stored score?" } },
        1,
      ),
    ).toMatchObject({
      event_score: "Stored score?",
      liked: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.liked,
    });
    expect(resolveCampaignCopy(undefined, 2).table_fit).toBe(
      POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.table_fit,
    );
  });

  it("fails closed on unsupported persisted versions", () => {
    expect(() => getPostEventFeedbackQuestionSet(3)).toThrow(
      UnsupportedPostEventFeedbackQuestionSetVersionError,
    );
    expect(() => resolveCampaignCopy(undefined, 3)).toThrow(
      UnsupportedPostEventFeedbackQuestionSetVersionError,
    );
  });

  it("filters contradiction cleanup to the active version's keys", () => {
    expect(
      contradictedPostEventFeedbackQuestionKeys("avoid", [
        "event_score",
        "meet_again",
        "avoid",
      ]),
    ).toEqual(["meet_again"]);
    expect(
      contradictedPostEventFeedbackQuestionKeys("avoid", [
        "event_score",
        "liked",
        "meet_again",
        "avoid",
      ]),
    ).toEqual(["liked", "meet_again"]);
  });
});
