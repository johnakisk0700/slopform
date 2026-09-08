import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_POLICY_QUESTIONS,
  isUnansweredPolicyQuestion,
} from "./policy-answers.js";

describe("post-event feedback policy answers", () => {
  it("raises for exactly the recognised-but-unanswered questions", () => {
    const unanswered = POST_EVENT_FEEDBACK_POLICY_QUESTIONS.filter((question) =>
      isUnansweredPolicyQuestion(question),
    );
    // `delete_my_data` is answer-less and deliberately absent: the handoff path
    // already flags it, and two reasons for one message is the same news twice.
    expect(unanswered).toEqual([
      "how_long_kept",
      "is_it_anonymous",
      "other_data_handling",
    ]);
  });
});
