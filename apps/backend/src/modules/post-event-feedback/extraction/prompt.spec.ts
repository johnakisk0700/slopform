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

  it("names the person writing, so the rule against answering about yourself can be followed", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context({ respondentDisplayName: "Νίκος Αυτοθαυμαστάκιας" }),
      copy: COPY,
    });

    // Validation refuses `subject_is_respondent`, and the system prompt has
    // always forbidden it — but the respondent was never named anywhere, so the
    // model was asked to avoid a person it could not identify. Worse when they
    // share a first name with a candidate: resolving «ο Νίκος» to the candidate
    // was the reasonable reading of everything it had been told.
    expect(
      section(
        prompt.user,
        "ΣΥΝΟΜΙΛΗΤΗΣ (αυτός γράφει· ποτέ δεν είναι υποκείμενο)",
      ),
    ).toEqual(["- respondent-1 = Νίκος Αυτοθαυμαστάκιας"]);
  });

  it("still names the respondent when the display name is missing", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context({ respondentDisplayName: null }),
      copy: COPY,
    });

    // The id is what an answer carries, so it has to be there even when we have
    // nothing to call them.
    expect(
      section(
        prompt.user,
        "ΣΥΝΟΜΙΛΗΤΗΣ (αυτός γράφει· ποτέ δεν είναι υποκείμενο)",
      ),
    ).toEqual(["- respondent-1 = (άγνωστο όνομα)"]);
  });

  it("hands the alphabet decision to the code instead of asking the participant", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // «O Tasos itan o kalyteros» cost two directed answers: the rule read as a
    // blanket ban on transliteration, so the model asked who «Tasos» was
    // instead of proposing anything — and validate-proposal's alphabet folding,
    // which resolves exactly this when one candidate fits, had nothing to fold.
    // The model now echoes the name and the fold stays in one place.
    expect(prompt.system).toContain("4β.");
    expect(prompt.system).toContain("ΜΗΝ ρωτήσεις ποιον εννοεί");
    expect(prompt.system).toContain("ΑΚΡΙΒΩΣ όπως το έγραψε");
    expect(prompt.system).not.toContain("λατινική μεταγραφή ίση με");
    // Asking is still right for a name that genuinely fits two candidates.
    expect(prompt.system).toContain("ΠΕΡΙΣΣΟΤΕΡΟΥΣ ΑΠΟ ΕΝΑΝ υποψήφιο");
  });

  it("refuses to bank a name the participant is still weighing", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // Φάνης Πολυλογόπουλος produced three `liked` answers he never gave, about
    // three named real people, on his first run: he weighs everyone aloud
    // before deciding and every name he passed through was banked as a
    // preference. An invented answer is worse than a missing one — staff read
    // it and act on it.
    expect(prompt.system).toContain("7γ.");
    expect(prompt.system).toContain("ΖΥΓΙΖΕΤΑΙ δεν είναι απάντηση");
  });

  it("makes withdrawing a decision about the whole questionnaire", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // Both people the bot backed away from were left open with goals pending,
    // so the reminder ladder would chase them about a questionnaire the bot
    // itself had abandoned. `isCompleting` closes a conversation once every
    // goal is terminal; nothing was telling the model to make them terminal.
    expect(prompt.system).toContain("7δ.");
    expect(prompt.system).toContain("declined σε αυτή την κλήση");
  });

  it("exempts a handoff from the rule that a withdrawal declines everything", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // «σβήστε ό,τι σας είπα σας παρακαλώ» read as a refusal to answer: the
    // remaining goals were declined, the ladder finished, and the thread closed
    // as completed over a deletion request nobody had looked at. Handing over
    // is not giving up — the open goals belong to the person taking it.
    expect(prompt.system).toContain("7ε.");
    expect(prompt.system).toContain("ΔΕΝ ισχύει όταν βάζεις handoff=true");
  });

  it("leaves an avoid drawn from a disclosure to the participant to confirm", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // Χαρά Παραπεντού said «να αποφύγω κανέναν βασικά» and then described
    // being grabbed at the bar. The model recorded the man as her `avoid`. It
    // reads as protective, but it is an answer she declined to give, and an
    // avoid changes future tables for two real people — so the bot asks.
    expect(prompt.system).toContain("9δ.");
    expect(prompt.system).toContain("ΜΗΝ το μετατρέπεις μόνος σου");
  });

  it("keeps a score the participant gave on behalf of two people", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // «εγώ κι ο άντρας μου βάζουμε 5» was refused three times as somebody
    // else's opinion and her score was lost. Rule 9β exists to stop a stranger's
    // view being filed as hers — not to discard one she plainly stated.
    expect(prompt.system).toContain("9γ.");
    expect(prompt.system).toContain("ΤΟΝ ΕΑΥΤΟ ΤΟΥ");
  });

  it("treats an explicit change of mind as answerable, not as settled", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    // validate-proposal already keeps the newer value and raises
    // `conflictingAnswerRevision` so an operator reconciles it. The revision
    // never arrived: a recorded score read as a closed goal, so «βασικά όχι, 2»
    // was returned as already_settled and the 4 stood.
    expect(prompt.system).toContain("8β.");
    expect(prompt.system).toContain("ΔΕΝ είναι already_settled");
    expect(prompt.system).toContain("την ΙΔΙΑ τιμή");
  });
});
