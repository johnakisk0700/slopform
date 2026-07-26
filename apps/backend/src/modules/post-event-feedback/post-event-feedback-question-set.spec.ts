import { describe, expect, it } from "vitest";

import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  POST_EVENT_FEEDBACK_COPY_KEYS,
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
  buildPostEventFeedbackQuestionLaunchSnapshot,
  isPostEventFeedbackAnswerQuestionKey,
  isPostEventFeedbackNoteType,
} from "./question-set.js";

describe("post-event feedback question set v1", () => {
  it("locks version 1 answer keys, note types and Greek copy from the plan", () => {
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_VERSION).toBe(1);
    expect(FEEDBACK_ANSWER_QUESTION_KEYS).toEqual([
      "event_score",
      "liked",
      "meet_again",
      "avoid",
    ]);
    expect(FEEDBACK_NOTE_TYPES).toEqual(["activity_interest", "general"]);
    expect(POST_EVENT_FEEDBACK_COPY_KEYS).toEqual([
      "intro",
      "event_score",
      "liked",
      "meet_again",
      "avoid",
      "closing",
      "stop_ack",
      "reminder",
      "reminder_followup",
      "cannot_read_media",
    ]);
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.intro).toContain(
      "Join The Six",
    );
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.intro).toContain("ΣΤΟΠ");
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.stop_ack).toBe(
      "Έγινε, δεν θα ξαναλάβεις μηνύματα από εμάς σε αυτό το νούμερο.",
    );
  });

  it("describes event_score as subjectless int 1-5 and people questions as candidate sets", () => {
    const eventScore = POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.find(
      (question) => question.key === "event_score",
    );
    const liked = POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.find(
      (question) => question.key === "liked",
    );

    expect(eventScore).toEqual({
      key: "event_score",
      valueKind: "int",
      subjectless: true,
      skippable: true,
      intMin: 1,
      intMax: 5,
    });
    expect(liked).toEqual({
      key: "liked",
      valueKind: "candidate_ids",
      subjectless: false,
      skippable: true,
    });
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.noteTypes).toEqual([
      { key: "activity_interest", maxLength: 500 },
      { key: "general", maxLength: 500 },
    ]);
  });

  it("builds a launch snapshot without mutating the canonical constants", () => {
    const snapshot = buildPostEventFeedbackQuestionLaunchSnapshot();
    expect(snapshot.questionSetVersion).toBe(1);
    expect(snapshot.copy).toEqual(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy);
    snapshot.copy.intro = "edited";
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.intro).not.toBe("edited");
  });

  it("narrows answer keys and note types at runtime", () => {
    expect(isPostEventFeedbackAnswerQuestionKey("liked")).toBe(true);
    expect(isPostEventFeedbackAnswerQuestionKey("intro")).toBe(false);
    expect(isPostEventFeedbackNoteType("general")).toBe(true);
    expect(isPostEventFeedbackNoteType("safety")).toBe(false);
  });
});
