import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS,
  POST_EVENT_FEEDBACK_CORPUS_CANDIDATE_SLOTS,
  type PostEventFeedbackRealModelCorpusCase,
} from "./post-event-feedback-real-model-corpus.js";
import { feedbackSimulatorRubricSchema } from "./simulator/simulator.schemas.js";

const CANDIDATE_PLACEHOLDER = /\{(candidate[1-7])\}/gu;

function corpusCase(id: string): PostEventFeedbackRealModelCorpusCase {
  const scenario = POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS.find(
    (candidate) => candidate.id === id,
  );

  if (!scenario) {
    throw new Error(`corpus case ${id} is missing`);
  }

  return scenario;
}

describe("post-event feedback real-model corpus", () => {
  it("keeps scenario ids unique", () => {
    const ids = POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS.map(
      (scenario) => scenario.id,
    );

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every rubric readable by the simulator that runs it", () => {
    // `simulator.schemas.ts` mirrors this file's categories and reply intents by
    // hand, because it is the HTTP boundary and publishes its own enums. Nothing
    // makes the two agree: a value added here alone still typechecks, and the
    // `feedbackSimulatorRubricSchema.parse` that would reject it happens inside
    // a simulator run — so the failure arrives as a broken dev surface, on the
    // one scenario somebody deliberately chose, long after the commit. This is
    // that parse, brought forward to CI.
    for (const scenario of POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS) {
      expect(
        () => feedbackSimulatorRubricSchema.parse(scenario.rubric),
        `${scenario.id} uses a rubric value the simulator does not publish`,
      ).not.toThrow();
    }
  });

  it("keeps every transcript renderable against its declared live candidates", () => {
    for (const scenario of POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS) {
      expect(
        scenario.messages.length,
        `${scenario.id} must contain participant testimony`,
      ).toBeGreaterThan(0);
      expect(
        scenario.messages[0]?.afterMs,
        `${scenario.id} must start at t+0`,
      ).toBe(0);

      const referencedSlots = scenario.messages.flatMap((message) => {
        expect(
          message.afterMs,
          `${scenario.id} has a negative relative delay`,
        ).toBeGreaterThanOrEqual(0);
        return [...message.textTemplate.matchAll(CANDIDATE_PLACEHOLDER)].map(
          (match) => match[1],
        );
      });

      for (const slot of referencedSlots) {
        const ordinal =
          POST_EVENT_FEEDBACK_CORPUS_CANDIDATE_SLOTS.indexOf(
            slot as (typeof POST_EVENT_FEEDBACK_CORPUS_CANDIDATE_SLOTS)[number],
          ) + 1;
        expect(
          ordinal,
          `${scenario.id} references an unsupported candidate slot`,
        ).toBeGreaterThan(0);
        expect(
          ordinal,
          `${scenario.id} references ${slot} but declares only ${scenario.requiredCandidateCount} candidates`,
        ).toBeLessThanOrEqual(scenario.requiredCandidateCount);
      }
    }
  });

  it("does not leak template grammar into participant-facing Greek", () => {
    for (const scenario of POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS) {
      for (const message of scenario.messages) {
        expect(
          message.textTemplate,
          `${scenario.id} contains gender-slash boilerplate`,
        ).not.toMatch(
          /(?:ο|η|τον|την|του|της|ος|α|ός|ή)\/(?:ο|η|τον|την|του|της|ος|α|ός|ή)/iu,
        );
      }
    }
  });

  // The two assertions below pin *content*, which nothing else here does — the
  // rest of this file checks that a rubric is well-formed, not what it says.
  // They exist because both values were wrong in ways that typecheck, parse and
  // pass every structural test, and both cost paid runs to discover.
  it("keeps the hostility band calibrated across the refusal register", () => {
    // The S69/S70 fork reads one boolean, and the application's two endings hang
    // off it: the same three messages either close as `declined` with the
    // declined copy, or stay open with nothing sent at all. On 2026-07-31 three
    // models split three ways on that judgement because no graded case sat
    // between «άντε γαμήσου ρε μποτ» and crude-about-an-attendee. Flipping any
    // row below re-opens the fork, so it should take a deliberate edit here.
    expect(corpusCase("insults_the_bot").rubric.hostileToUs).toBe(true);

    for (const id of ["annoyed_but_not_hostile", "declines_every_question"]) {
      const scenario = corpusCase(id);

      expect(
        scenario.rubric.hostileToUs,
        `${id} is the civil half of the fork and must not tick the ladder`,
      ).toBe(false);
      expect(
        scenario.rubric.attention,
        `${id} declines questions and describes no incident`,
      ).toBeNull();
      expect(
        [...(scenario.rubric.skippedGoals ?? [])].sort(),
        `${id} withdraws from the whole questionnaire, not the current goal`,
      ).toEqual(["avoid", "event_score", "liked", "meet_again"]);
    }
  });

  it("leaves the 9δ avoid undecided in both directions", () => {
    // Prompt rule 9δ owns this shape — «κανέναν» first, an unpleasant
    // description second — and says we decide neither way: the description is a
    // note and the avoid goes back to her as a question. Banking it as
    // skipped-confirmed is as much a decision as recording it, and the rubric
    // did exactly that until the 2026-07-31 audit, failing every model that
    // obeyed the prompt it was given.
    const scenario = corpusCase("discloses_as_the_very_last_thing");

    expect(scenario.rubric.skippedGoals ?? []).not.toContain("avoid");
    expect(scenario.rubric.forbiddenAnswers).toContainEqual({
      question: "avoid",
      about: "candidate4",
    });
    expect(scenario.rubric.reply?.requiredIntent).toBe(
      "ask_whether_to_mark_avoid",
    );
    expect(scenario.rubric.notes?.[0]?.about).toBe("candidate4");
  });
});
