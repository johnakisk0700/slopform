import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { feedbackBurstOutboundInFlight } from "./feedback-burst-settlement.mjs";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const HORIZON = 45_000;

describe("feedbackBurstOutboundInFlight", () => {
  it("treats a live execution lease as in flight", () => {
    assert.equal(
      feedbackBurstOutboundInFlight(
        {
          state: "running",
          nextActionAt: null,
          claimExpiresAt: "2026-08-04T12:05:00.000Z",
        },
        NOW,
        HORIZON,
      ),
      true,
    );
  });

  it("waits out a scheduled action already due", () => {
    assert.equal(
      feedbackBurstOutboundInFlight(
        { state: "scheduled", nextActionAt: "2026-08-04T11:59:50.000Z" },
        NOW,
        HORIZON,
      ),
      true,
    );
  });

  it("waits out a debounced action due inside the horizon", () => {
    assert.equal(
      feedbackBurstOutboundInFlight(
        { state: "scheduled", nextActionAt: "2026-08-04T12:00:30.000Z" },
        NOW,
        HORIZON,
      ),
      true,
    );
  });

  it("does not deadlock on work scheduled beyond the horizon", () => {
    assert.equal(
      feedbackBurstOutboundInFlight(
        { state: "scheduled", nextActionAt: "2026-08-04T14:00:00.000Z" },
        NOW,
        HORIZON,
      ),
      false,
    );
  });

  it("ignores idle, parked and missing automation", () => {
    for (const automation of [
      { state: "idle", nextActionAt: null },
      { state: "parked", nextActionAt: null },
      undefined,
    ]) {
      assert.equal(
        feedbackBurstOutboundInFlight(automation, NOW, HORIZON),
        false,
      );
    }
  });

  it("ignores a scheduled row without a parseable horizon", () => {
    for (const nextActionAt of [null, "not-a-date"]) {
      assert.equal(
        feedbackBurstOutboundInFlight(
          { state: "scheduled", nextActionAt },
          NOW,
          HORIZON,
        ),
        false,
      );
    }
  });
});
