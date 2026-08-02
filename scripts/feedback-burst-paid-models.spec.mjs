import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FEEDBACK_BURST_COMPARISONS,
  FEEDBACK_BURST_PAID_MODELS,
  FEEDBACK_BURST_PROFILES,
  assertFeedbackBurstLiveGuestCallAllowed,
  assertFeedbackBurstLiveGuestTreatment,
  assertFeedbackBurstQuestionSetVersion,
  assertFeedbackBurstTreatmentAdapter,
  resolveFeedbackBurstLiveGuests,
  resolveFeedbackBurstTreatment,
} from "./feedback-burst-paid-models.mjs";

describe("feedback burst paid policy", () => {
  it("defines prova as the exact direct-OpenAI Terra treatment", () => {
    assert.deepEqual(FEEDBACK_BURST_PROFILES.prova, {
      name: "prova",
      mode: "profile",
      model: "openai/gpt-5.6-terra",
      provider: "openai",
      providerModelId: "gpt-5.6-terra",
      controls: {
        reasoningEffort: "medium",
        replyReasoningEffort: "low",
        attentionReasoningEffort: "medium",
        serviceTier: null,
      },
    });
    assert.ok(Object.isFrozen(FEEDBACK_BURST_PROFILES.prova));
    assert.ok(Object.isFrozen(FEEDBACK_BURST_PROFILES.prova.controls));
    assert.doesNotThrow(() =>
      assertFeedbackBurstTreatmentAdapter(FEEDBACK_BURST_PROFILES.prova, {
        provider: "openai",
        providerModelId: "gpt-5.6-terra",
      }),
    );
    assert.throws(
      () =>
        assertFeedbackBurstTreatmentAdapter(FEEDBACK_BURST_PROFILES.prova, {
          provider: "openrouter",
          providerModelId: "openai/gpt-5.6-terra",
        }),
      /requires openai\/gpt-5\.6-terra/u,
    );
  });

  it("keeps Qwen behind the explicit comparison selector", () => {
    assert.deepEqual(FEEDBACK_BURST_PAID_MODELS, [
      "openai/gpt-5.6-terra",
      "qwen/qwen3.7-max",
    ]);
    assert.ok(!FEEDBACK_BURST_PAID_MODELS.includes("openai/gpt-5.6-luna"));
    assert.equal(resolveFeedbackBurstTreatment({}), null);
    assert.equal(
      resolveFeedbackBurstTreatment({ profile: "prova" }),
      FEEDBACK_BURST_PROFILES.prova,
    );
    assert.equal(
      resolveFeedbackBurstTreatment({ comparison: "qwen" }),
      FEEDBACK_BURST_COMPARISONS.qwen,
    );
    assert.throws(
      () => resolveFeedbackBurstTreatment({ model: "qwen/qwen3.7-max" }),
      /--comparison qwen/u,
    );
    assert.throws(
      () =>
        resolveFeedbackBurstTreatment({
          profile: "prova",
          comparison: "qwen",
        }),
      /mutually exclusive/u,
    );
  });

  it("defaults live guests to deterministic silence and requires two flags", () => {
    assert.equal(resolveFeedbackBurstLiveGuests({}), false);
    assert.throws(
      () => resolveFeedbackBurstLiveGuests({ "live-guests": true }),
      /add --confirm-live-guests/u,
    );
    assert.throws(
      () => resolveFeedbackBurstLiveGuests({ "confirm-live-guests": true }),
      /without --live-guests/u,
    );
    assert.equal(
      resolveFeedbackBurstLiveGuests({
        "live-guests": true,
        "confirm-live-guests": true,
      }),
      true,
    );
    assert.throws(
      () => assertFeedbackBurstLiveGuestCallAllowed(false),
      /Refusing cursor-agent persona call/u,
    );
    assert.doesNotThrow(() => assertFeedbackBurstLiveGuestCallAllowed(true));
    assert.throws(
      () => assertFeedbackBurstLiveGuestTreatment(true, null),
      /deterministic stub cannot interpret improvised participant messages/u,
    );
    assert.doesNotThrow(() =>
      assertFeedbackBurstLiveGuestTreatment(
        true,
        FEEDBACK_BURST_PROFILES.prova,
      ),
    );
    assert.doesNotThrow(() =>
      assertFeedbackBurstLiveGuestTreatment(false, null),
    );
  });

  it("fails closed unless campaign read-back says question-set V2", () => {
    assert.deepEqual(
      assertFeedbackBurstQuestionSetVersion(
        { id: "campaign-v2", questionSetVersion: 2 },
        "campaign campaign-v2",
      ),
      { id: "campaign-v2", questionSetVersion: 2 },
    );
    assert.throws(
      () =>
        assertFeedbackBurstQuestionSetVersion(
          { id: "campaign-v1", questionSetVersion: 1 },
          "reused campaign campaign-v1",
        ),
      /reused campaign campaign-v1 must use feedback question-set V2; received 1/u,
    );
    assert.throws(
      () =>
        assertFeedbackBurstQuestionSetVersion(
          { id: "campaign-unknown" },
          "campaign read-back campaign-unknown",
        ),
      /received missing/u,
    );
  });
});
