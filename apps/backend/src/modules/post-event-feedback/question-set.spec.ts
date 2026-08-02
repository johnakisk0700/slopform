import { describe, expect, it } from "vitest";

import {
  CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  POST_EVENT_FEEDBACK_COPY_KEYS,
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  POST_EVENT_FEEDBACK_QUESTION_SET_V2,
  UnsupportedPostEventFeedbackQuestionSetVersionError,
  buildPostEventFeedbackQuestionLaunchSnapshot,
  contradictedPostEventFeedbackQuestionKeys,
  getPostEventFeedbackQuestionSet,
  isPostEventFeedbackAnswerQuestionKey,
  isPostEventFeedbackNoteType,
  resolveCampaignCopy,
} from "./question-set.js";

describe("post-event feedback versioned question sets", () => {
  it("keeps the global persistence vocabulary as the union of V1 and V2", () => {
    expect(FEEDBACK_ANSWER_QUESTION_KEYS).toEqual([
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
      "liked",
      "meet_again",
      "avoid",
    ]);
    expect(FEEDBACK_NOTE_TYPES).toEqual(["activity_interest", "general"]);
    expect(POST_EVENT_FEEDBACK_COPY_KEYS).toEqual([
      "intro",
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
      "liked",
      "meet_again",
      "avoid",
      "closing",
      "closing_after_safety",
      "declined",
      "stop_ack",
      "reminder",
      "reminder_followup",
      "cannot_read_media",
    ]);
  });

  it("preserves V1 goal order and copy", () => {
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.version).toBe(1);
    expect(
      POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.map(
        (question) => question.key,
      ),
    ).toEqual(["event_score", "liked", "meet_again", "avoid"]);
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.intro).toContain(
      "2-3 πράγματα",
    );
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.avoid).toContain(
      "Μένει αυστηρά μεταξύ μας",
    );
  });

  it("launches new campaigns on the six-goal V2 questionnaire", () => {
    expect(CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION).toBe(2);
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.version).toBe(2);
    expect(
      POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions.map(
        (question) => question.key,
      ),
    ).toEqual([
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
      "meet_again",
      "avoid",
    ]);
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.intro).toContain(
      "6 σύντομες, προαιρετικές ερωτήσεις",
    );
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.intro).toContain(
      "δεν κοινοποιούνται ατομικά σε άλλους συμμετέχοντες",
    );
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.intro).toContain("ΣΤΟΠ");
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.avoid).not.toContain(
      "μεταξύ μας",
    );
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.stop_ack).toContain(
      "μηνύματα feedback",
    );
  });

  it("describes all four V2 score questions as subjectless integers 1-5", () => {
    for (const key of [
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
    ] as const) {
      expect(
        POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions.find(
          (question) => question.key === key,
        ),
      ).toEqual({
        key,
        valueKind: "int",
        subjectless: true,
        skippable: true,
        intMin: 1,
        intMax: 5,
      });
    }
  });

  it("builds an isolated current snapshot and can explicitly snapshot V1", () => {
    const current = buildPostEventFeedbackQuestionLaunchSnapshot();
    const legacy = buildPostEventFeedbackQuestionLaunchSnapshot(1);

    expect(current.questionSetVersion).toBe(2);
    expect(current.copy).toEqual(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy);
    expect(legacy.questionSetVersion).toBe(1);
    expect(legacy.copy).toEqual(POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy);

    current.copy.intro = "edited";
    expect(POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy.intro).not.toBe("edited");
  });

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

  it("narrows global answer keys and note types at runtime", () => {
    expect(isPostEventFeedbackAnswerQuestionKey("table_fit")).toBe(true);
    expect(isPostEventFeedbackAnswerQuestionKey("intro")).toBe(false);
    expect(isPostEventFeedbackNoteType("general")).toBe(true);
    expect(isPostEventFeedbackNoteType("safety")).toBe(false);
  });
});
