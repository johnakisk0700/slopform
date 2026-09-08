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
        paidModel: true,
        replyObligationWaived: false,
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
        paidModel: false,
        replyObligationWaived: false,
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

  it("allows paid scripted supersession while preserving the anti-flood bound", () => {
    assert.deepEqual(
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 4,
        maxReceived: 4,
        liveModel: false,
        paidModel: true,
        replyObligationWaived: false,
        injectedCount: 6,
        receivedCount: 3,
      }),
      {
        label: FEEDBACK_BURST_DELIVERY_LABEL,
        expected: "2–4",
        actual: "3",
        passed: true,
      },
    );
    assert.equal(
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 4,
        maxReceived: 4,
        liveModel: false,
        paidModel: true,
        replyObligationWaived: false,
        injectedCount: 6,
        receivedCount: 1,
      }).passed,
      false,
    );
    assert.equal(
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 4,
        maxReceived: 4,
        liveModel: false,
        paidModel: true,
        replyObligationWaived: false,
        injectedCount: 6,
        receivedCount: 5,
      }).passed,
      false,
    );
  });

  it("does not demand a bot reply for the live turn that raised handoff", () => {
    const result = buildFeedbackBurstDeliveryExpectation({
      minReceived: 1,
      maxReceived: 40,
      liveModel: true,
      paidModel: true,
      replyObligationWaived: true,
      injectedCount: 7,
      receivedCount: 7,
    });

    assert.equal(result.expected, "7–40");
    assert.equal(result.passed, true);
  });

  it("waives the live reply obligation on unresolved handoff attention while keeping the ceiling", () => {
    const expectation = (receivedCount) =>
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 1,
        maxReceived: 40,
        liveModel: true,
        paidModel: true,
        replyObligationWaived: true,
        injectedCount: 7,
        receivedCount,
      });

    assert.equal(expectation(7).expected, "7–40");
    assert.equal(expectation(7).passed, true);
    assert.equal(expectation(41).passed, false);
  });

  it("lets a paid scripted persona end one reply short when a handoff waived the obligation", () => {
    const expectation = (receivedCount) =>
      buildFeedbackBurstDeliveryExpectation({
        minReceived: 2,
        maxReceived: 2,
        liveModel: false,
        paidModel: true,
        replyObligationWaived: true,
        injectedCount: 2,
        receivedCount,
      });

    assert.equal(expectation(1).expected, "1–2");
    assert.equal(expectation(1).passed, true);
    assert.equal(expectation(3).passed, false);
  });

  it("never grants the waiver to a deterministic stub run", () => {
    const result = buildFeedbackBurstDeliveryExpectation({
      minReceived: 2,
      maxReceived: 2,
      liveModel: false,
      paidModel: false,
      replyObligationWaived: true,
      injectedCount: 2,
      receivedCount: 1,
    });

    assert.equal(result.expected, "2–2");
    assert.equal(result.passed, false);
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
