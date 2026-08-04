import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { feedbackBurstLiveGuestStopReason } from "./feedback-burst-live-guest.mjs";

describe("feedbackBurstLiveGuestStopReason", () => {
  it("stops on lifecycle closure before another guest turn", () => {
    assert.deepEqual(
      feedbackBurstLiveGuestStopReason({
        lifecycle: { state: "closed", reason: "completed" },
        awaitingHuman: false,
      }),
      { kind: "closed", reason: "completed" },
    );
  });

  it("stops an open bot-controlled safety handoff", () => {
    assert.deepEqual(
      feedbackBurstLiveGuestStopReason({
        lifecycle: { state: "open", reason: null },
        control: { mode: "bot" },
        awaitingHuman: true,
      }),
      { kind: "awaiting_human", reason: null },
    );
  });

  it("continues only while the conversation is open and not handed off", () => {
    assert.equal(
      feedbackBurstLiveGuestStopReason({
        lifecycle: { state: "open", reason: null },
        awaitingHuman: false,
      }),
      null,
    );
  });
});
