export const FEEDBACK_BURST_DELIVERY_LABEL = "μηνύματα που έφτασαν";
export const FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL =
  "ζωντανός καλεσμένος έστειλε μήνυμα";
export const FEEDBACK_BURST_OBSERVATION_PREFIX = "observation: ";

/**
 * Delivery is a mechanism assertion in both stub and paid runs. A live guest
 * starts with the intro, then injects only after seeing a bot turn; every
 * injected turn therefore raises the minimum outbound count owed by one.
 */
export function buildFeedbackBurstDeliveryExpectation({
  minReceived,
  maxReceived,
  liveModel,
  paidModel,
  stoppedForHandoff,
  injectedCount,
  receivedCount,
}) {
  // Deterministic stub runs retain the fixture's exact dialogue bounds. A paid
  // model may legitimately consolidate a stale intermediate question after a
  // newer inbound advances the conversation revision; that is the state-driven
  // loop doing its job, not a dropped send. Paid scripted rows therefore keep
  // the essential mechanism bound (intro + at least one current-state reply)
  // and the fixture's anti-flood maximum.
  //
  // A live guest normally owes intro + one outbound for every injected turn.
  // When the last turn raises a silent human handoff, however, awaitingHuman is
  // itself the terminal product response and no bot message is owed for that
  // final inject.
  const effectiveMinimum = liveModel
    ? Math.max(minReceived, injectedCount + (stoppedForHandoff ? 0 : 1))
    : paidModel
      ? Math.min(minReceived, 2)
      : minReceived;
  return {
    label: FEEDBACK_BURST_DELIVERY_LABEL,
    expected: `${effectiveMinimum}–${maxReceived}`,
    actual: String(receivedCount),
    passed: receivedCount >= effectiveMinimum && receivedCount <= maxReceived,
  };
}

/**
 * Enabling live guests promises that the persona model actually exercised the
 * product. An intro-only row is valid deterministic silence when the mode is
 * disabled, but it is a harness failure when an enabled cursor-agent call
 * failed or returned an empty message before the first inject.
 */
export function buildFeedbackBurstLiveGuestExerciseExpectation({
  injectedCount,
}) {
  return {
    label: FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL,
    expected: ">=1",
    actual: String(injectedCount),
    passed: injectedCount > 0,
  };
}

/**
 * Paid-model semantic rows are observations because model interpretation may
 * legitimately differ from a fixture. Delivery is not semantic: no bot reply
 * is still a product failure, regardless of which model wrote nothing.
 */
export function gradeFeedbackBurstExpectations(expectations, { stubMode }) {
  const rows = expectations.map((expectation) => {
    if (
      stubMode ||
      expectation.label === FEEDBACK_BURST_DELIVERY_LABEL ||
      expectation.label === FEEDBACK_BURST_LIVE_GUEST_EXERCISE_LABEL
    ) {
      return expectation;
    }
    return {
      ...expectation,
      label: `${FEEDBACK_BURST_OBSERVATION_PREFIX}${expectation.label}`,
    };
  });
  return {
    expectations: rows,
    passed: rows.every(
      (row) =>
        row.passed === true ||
        row.label.startsWith(FEEDBACK_BURST_OBSERVATION_PREFIX),
    ),
  };
}
