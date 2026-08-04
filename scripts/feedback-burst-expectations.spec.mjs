import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFeedbackBurstDeliveryExpectation,
  buildFeedbackBurstLiveGuestExerciseExpectation,
  FEEDBACK_BURST_DELIVERY_LABEL,
  FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL,
  gradeFeedbackBurstExpectations,
} from "./feedback-burst-expectations.mjs";

describe("buildFeedbackBurstDeliveryExpectation", () => {
  it("allows intro-only deterministic silence but requires a reply after each live inject", () => {
    const expectation = (injectedCount, receivedCount) =>
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 1,
        maxReceived: 40,
        liveModel: true,
        injectedCount,
        receivedCount,
      });

    assert.deepEqual(expectation(0, 1), {
      label: FEEDBACK_BURST_DELIVERY_LABEL,
      expected: "1–40",
      actual: "1",
      passed: true,
    });
    assert.equal(expectation(1, 1).passed, false);
    assert.equal(expectation(1, 1).expected, "2–40");
    assert.equal(expectation(3, 4).passed, true);
    assert.equal(expectation(3, 4).expected, "4–40");
  });

  it("keeps scripted fixture bounds independent of fragment count", () => {
    assert.deepEqual(
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 3,
        maxReceived: 3,
        liveModel: false,
        injectedCount: 6,
        receivedCount: 2,
      }),
      {
        label: FEEDBACK_BURST_DELIVERY_LABEL,
        expected: "3–3",
        actual: "2",
        passed: false,
      },
    );
  });
});

describe("buildFeedbackBurstLiveGuestExerciseExpectation", () => {
  it("fails an enabled guest that never injected testimony", () => {
    assert.deepEqual(
      buildFeedbackBurstLiveGuestExerciseExpectation({ injectedCount: 0 }),
      {
        label: FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL,
        expected: ">=1",
        actual: "0",
        passed: false,
      },
    );
    assert.equal(
      buildFeedbackBurstLiveGuestExerciseExpectation({ injectedCount: 1 })
        .passed,
      true,
    );
  });
});

describe("gradeFeedbackBurstExpectations", () => {
  const lifecycleFailure = {
    label: "lifecycle",
    expected: "closed",
    actual: "open",
    passed: false,
  };
  const delivery = (passed) => ({
    label: FEEDBACK_BURST_DELIVERY_LABEL,
    expected: "2–2",
    actual: passed ? "2" : "1",
    passed,
  });
  const liveGuestExercise = (passed) => ({
    label: FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL,
    expected: ">=1",
    actual: passed ? "1" : "0",
    passed,
  });

  it("grades every fixture row in deterministic stub mode", () => {
    const result = gradeFeedbackBurstExpectations(
      [lifecycleFailure, delivery(true)],
      { stubMode: true },
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.expectations, [lifecycleFailure, delivery(true)]);
  });

  it("keeps delivery hard while turning paid semantic mismatches into observations", () => {
    const withReply = gradeFeedbackBurstExpectations(
      [lifecycleFailure, delivery(true)],
      { stubMode: false },
    );
    assert.equal(withReply.passed, true);
    assert.equal(withReply.expectations[0].label, "observation: lifecycle");
    assert.equal(
      withReply.expectations[1].label,
      FEEDBACK_BURST_DELIVERY_LABEL,
    );

    const withoutReply = gradeFeedbackBurstExpectations(
      [lifecycleFailure, delivery(false)],
      { stubMode: false },
    );
    assert.equal(withoutReply.passed, false);
  });

  it("keeps enabled live-guest execution hard in paid mode", () => {
    const missingGuest = gradeFeedbackBurstExpectations(
      [lifecycleFailure, liveGuestExercise(false), delivery(true)],
      { stubMode: false },
    );
    assert.equal(missingGuest.passed, false);
    assert.equal(
      missingGuest.expectations[1].label,
      FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL,
    );

    const exercisedGuest = gradeFeedbackBurstExpectations(
      [lifecycleFailure, liveGuestExercise(true), delivery(true)],
      { stubMode: false },
    );
    assert.equal(exercisedGuest.passed, true);
  });
});
