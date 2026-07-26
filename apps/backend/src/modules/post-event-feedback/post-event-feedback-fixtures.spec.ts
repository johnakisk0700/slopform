import { describe, expect, it } from "vitest";

import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
} from "@join-the-six/database";
import {
  isPostEventFeedbackAnswerQuestionKey,
  isPostEventFeedbackNoteType,
} from "./post-event-feedback-question-set.js";
import {
  POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES,
  getPostEventFeedbackExtractionFixture,
} from "./post-event-feedback-fixtures.js";
import { matchesPostEventFeedbackStopCommand } from "./post-event-feedback-stop-matcher.js";

describe("post-event feedback extraction fixtures", () => {
  it("covers the WP0 Greek transcript scenarios with unique ids", () => {
    expect(
      POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES.map((fixture) => fixture.id),
    ).toEqual([
      "happy_path",
      "multi_message_burst",
      "two_kostas_ambiguity",
      "unknown_name_subjectless_note",
      "unrelated_chat",
      "safety_language",
      "stop_mid_flow",
      "staff_follow_up_after_takeover",
    ]);
  });

  it("keeps typed expected outcomes aligned with allowed question and note keys", () => {
    for (const fixture of POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES) {
      const candidateIds = new Set(
        fixture.candidates.map((candidate) => candidate.participantId),
      );
      expect(candidateIds.has(fixture.respondentParticipantId)).toBe(false);

      for (const answer of fixture.expected.answers) {
        expect(isPostEventFeedbackAnswerQuestionKey(answer.questionKey)).toBe(
          true,
        );
        const subjectIds =
          "subjectParticipantIds" in answer
            ? (answer.subjectParticipantIds ?? [])
            : [];
        for (const subjectId of subjectIds) {
          expect(candidateIds.has(subjectId)).toBe(true);
          expect(subjectId).not.toBe(fixture.respondentParticipantId);
        }
      }

      for (const note of fixture.expected.notes) {
        expect(isPostEventFeedbackNoteType(note.noteType)).toBe(true);
        if (note.subjectParticipantId) {
          expect(candidateIds.has(note.subjectParticipantId)).toBe(true);
        }
      }
    }
  });

  it("annotates STOP, safety and ambiguity fixtures explicitly", () => {
    expect(
      getPostEventFeedbackExtractionFixture("stop_mid_flow").expected
        .stopMatched,
    ).toBe(true);
    expect(
      matchesPostEventFeedbackStopCommand(
        getPostEventFeedbackExtractionFixture("stop_mid_flow").messages.at(-1)!
          .text,
      ),
    ).toBe(true);

    expect(
      getPostEventFeedbackExtractionFixture("safety_language").expected
        .safetySignal,
    ).toBe(true);
    expect(
      getPostEventFeedbackExtractionFixture("two_kostas_ambiguity").expected
        .clarificationNeeded,
    ).toBe(true);
    expect(
      getPostEventFeedbackExtractionFixture("unknown_name_subjectless_note")
        .expected.notes[0]?.flaggedForReview,
    ).toBe(true);
  });

  it("requires every answer question key to appear in at least one fixture", () => {
    const coveredKeys = new Set<
      (typeof FEEDBACK_ANSWER_QUESTION_KEYS)[number]
    >();
    for (const fixture of POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES) {
      for (const answer of fixture.expected.answers) {
        if ("skipped" in answer && answer.skipped) {
          continue;
        }
        coveredKeys.add(answer.questionKey);
      }
    }
    expect([...coveredKeys].sort()).toEqual([
      "event_score",
      "liked",
      "meet_again",
    ]);
  });

  it("requires every note type to appear in at least one fixture", () => {
    const coveredNoteTypes = new Set<(typeof FEEDBACK_NOTE_TYPES)[number]>();
    for (const fixture of POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES) {
      for (const note of fixture.expected.notes) {
        coveredNoteTypes.add(note.noteType);
      }
    }
    expect([...coveredNoteTypes].sort()).toEqual([
      "activity_interest",
      "general",
    ]);
  });
});
