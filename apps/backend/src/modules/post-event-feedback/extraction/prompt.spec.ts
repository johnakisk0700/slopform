import { describe, expect, it } from "vitest";

import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "../question-set.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import { buildFeedbackExtractionPrompt } from "./prompt.js";

const COPY = POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy;

function context(
  overrides: Partial<FeedbackExtractionContext> = {},
): FeedbackExtractionContext {
  return {
    respondentParticipantId: "respondent-1",
    respondentDisplayName: "Τάσος",
    candidates: [{ participantId: "cand-niki", displayName: "Νίκη" }],
    goals: [
      {
        key: "event_score",
        ordinal: 1,
        prompt: COPY.event_score,
        status: "answered",
      },
      { key: "liked", ordinal: 2, prompt: COPY.liked, status: "asked" },
      {
        key: "meet_again",
        ordinal: 3,
        prompt: COPY.meet_again,
        status: "pending",
      },
      { key: "avoid", ordinal: 4, prompt: COPY.avoid, status: "pending" },
    ],
    acceptedAnswers: [],
    acceptedNotes: [],
    replyAllowed: true,
    messages: [
      {
        id: "msg-p-1",
        seq: 1,
        actor: "participant",
        occurredAt: "2026-07-27T10:00:00.000Z",
        text: "η Νικη περασε, θα την ξαναεβλεπα",
      },
    ],
    newParticipantMessageIds: ["msg-p-1"],
    ...overrides,
  };
}

function section(prompt: string, header: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.indexOf(header);
  const rest = lines.slice(start + 1);
  const end = rest.indexOf("");
  return end < 0 ? rest : rest.slice(0, end);
}

describe("buildFeedbackExtractionPrompt", () => {
  it("states each goal's status next to the question it was asked as", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // The wording is what separates `liked` ("ιδιαίτερα καλή εντύπωση") from
    // `meet_again` ("θα ήθελες να ξαναβρεθείς"). Reading the status without it
    // left the distinction to be recalled from another block.
    expect(section(prompt.user, "ΣΤΟΧΟΙ")).toEqual([
      `- 1. event_score: answered — ρωτήθηκε ως «${COPY.event_score}»`,
      `- 2. liked: asked — ρωτήθηκε ως «${COPY.liked}»`,
      `- 3. meet_again: pending — ρωτήθηκε ως «${COPY.meet_again}»`,
      `- 4. avoid: pending — ρωτήθηκε ως «${COPY.avoid}»`,
    ]);
  });

  it("quotes the goal's own stored wording, so a copy edit cannot rewrite it", () => {
    const snapshotWording = "Ποιος σου έκανε την καλύτερη εντύπωση;";
    const prompt = buildFeedbackExtractionPrompt({
      context: context({
        goals: [
          {
            key: "liked",
            ordinal: 1,
            prompt: snapshotWording,
            status: "asked",
          },
        ],
      }),
      copy: COPY,
    });

    expect(section(prompt.user, "ΣΤΟΧΟΙ")).toEqual([
      `- 1. liked: asked — ρωτήθηκε ως «${snapshotWording}»`,
    ]);
  });

  it("tells the model a person answering one goal still answers the others", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // The observed failure this rule exists for: «η Μαρία μου άρεσε, θα
    // ξαναέβγαινα μαζί της» produced `meet_again` and nothing for `liked`, as
    // if naming somebody once spent them. Forcing a verdict per goal did not
    // move it, because the model was not omitting a goal — it was collapsing
    // two relations about one person into one.
    expect(prompt.system).toContain("7β.");
    expect(prompt.system).toContain("δεν αποκλείουν ο ένας τον άλλον");
    expect(prompt.system).toContain("liked ΚΑΙ στο meet_again");
  });
});
