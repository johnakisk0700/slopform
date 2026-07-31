import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_POLICY_QUESTIONS,
  POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS,
  isUnansweredPolicyQuestion,
} from "./policy-answers.js";

/**
 * The doc is the owner's surface and this table is the running one. The two are
 * one decision, so a sentence edited in either place alone must fail loudly —
 * an approved answer is a commitment the platform keeps, and the worst version
 * of this feature is the doc promising one wording while the phone receives
 * another.
 */
const doc = readFileSync(
  resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../../../../docs/backend/modules/post-event-feedback-policy-answers.md",
  ),
  "utf8",
);

function documentedAnswer(question: string): string | null {
  const section = doc.split(`### \`${question}\``)[1]?.split("\n### ")[0];
  expect(section, `doc section for ${question}`).toBeDefined();
  const approved = /\*\*Approved:\*\* «([^»]+)»/u.exec(section ?? "");
  if (!approved) {
    return null;
  }
  return (approved[1] ?? "").replaceAll(/\s+/gu, " ").trim();
}

describe("post-event feedback policy answers", () => {
  it("matches the adopted doc, sentence for sentence", () => {
    for (const question of POST_EVENT_FEEDBACK_POLICY_QUESTIONS) {
      if (question === "other_data_handling") {
        // The catch-all has no doc section: it is the absence of one.
        continue;
      }
      expect(documentedAnswer(question), question).toBe(
        POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS[question].answer,
      );
    }
  });

  it("keeps the launch copy's «Μένει αυστηρά μεταξύ μας» promise honoured", () => {
    // The avoid question already promises confidentiality in production copy.
    // Whatever else this table says, the answer to «θα το μάθει;» must exist
    // and must say no — the questionnaire promised first.
    const answer =
      POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS.will_they_find_out.answer;
    expect(answer).not.toBeNull();
    expect(answer).toContain("Όχι");
  });

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

  it("gives every question a description for the classifier and no answer inside it", () => {
    for (const question of POST_EVENT_FEEDBACK_POLICY_QUESTIONS) {
      const definition =
        POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS[question];
      expect(definition.asks.length).toBeGreaterThan(10);
      if (definition.answer !== null) {
        // The `asks` line is the one part of an entry a model is shown; an
        // answer leaking into it would defeat the whole split.
        expect(definition.asks).not.toContain(definition.answer);
      }
    }
  });
});
