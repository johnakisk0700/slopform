import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS,
  POST_EVENT_FEEDBACK_CORPUS_CANDIDATE_SLOTS,
} from "./post-event-feedback-real-model-corpus.js";
import { feedbackSimulatorRubricSchema } from "./simulator/simulator.schemas.js";

const CANDIDATE_PLACEHOLDER = /\{(candidate[1-7])\}/gu;

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
});
