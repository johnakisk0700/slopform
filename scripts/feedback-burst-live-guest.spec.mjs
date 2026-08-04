import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  feedbackBurstLiveGuestStopReason,
  feedbackBurstReplySuppressedByHandoff,
} from "./feedback-burst-live-guest.mjs";

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

  it("keeps talking through unresolved safety reasons that never raised awaitingHuman", () => {
    // Grading may waive the reply obligation for this state, but the guest
    // loop must not stop spending turns on it — that widening belongs to
    // feedbackBurstReplySuppressedByHandoff alone.
    assert.equal(
      feedbackBurstLiveGuestStopReason({
        lifecycle: { state: "open", reason: null },
        awaitingHuman: false,
        attentionReasons: [
          { kind: "safety", resolvedAt: null },
          { kind: "safety", resolvedAt: null },
        ],
      }),
      null,
    );
  });
});

describe("feedbackBurstReplySuppressedByHandoff", () => {
  it("waives the reply while the conversation awaits a human", () => {
    assert.equal(
      feedbackBurstReplySuppressedByHandoff({
        awaitingHuman: true,
        attentionReasons: [],
      }),
      true,
    );
  });

  it("waives the reply on an unresolved safety attention reason", () => {
    assert.equal(
      feedbackBurstReplySuppressedByHandoff({
        awaitingHuman: false,
        attentionReasons: [{ kind: "safety", resolvedAt: null }],
      }),
      true,
    );
  });

  it("restores the obligation once every handoff reason is resolved", () => {
    assert.equal(
      feedbackBurstReplySuppressedByHandoff({
        awaitingHuman: false,
        attentionReasons: [
          { kind: "safety", resolvedAt: "2026-08-04T16:44:08Z" },
        ],
      }),
      false,
    );
  });

  it("ignores unresolved reasons whose kind is not a handoff", () => {
    assert.equal(
      feedbackBurstReplySuppressedByHandoff({
        awaitingHuman: false,
        attentionReasons: [{ kind: "answer_revision", resolvedAt: null }],
      }),
      false,
    );
  });

  it("owes the reply when there are no attention reasons at all", () => {
    assert.equal(
      feedbackBurstReplySuppressedByHandoff({
        awaitingHuman: false,
        attentionReasons: [],
      }),
      false,
    );
    assert.equal(
      feedbackBurstReplySuppressedByHandoff({ awaitingHuman: false }),
      false,
    );
  });
});
