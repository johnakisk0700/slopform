import { describe, expect, it } from "vitest";

import {
  attestFeedbackWorkers,
  createFeedbackWorkerRegistrationName,
  createFeedbackWorkerRegistrationNameFromEnvironment,
  parseFeedbackWorkerRegistrationName,
  resolveFeedbackWorkerControlProfile,
} from "./worker-attestation.js";

describe("feedback worker control attestation", () => {
  it("round-trips the exact paid Terra treatment deterministically", () => {
    const profile = paidTerraProfile();
    const first = createFeedbackWorkerRegistrationName(profile);
    const second = createFeedbackWorkerRegistrationName(profile);

    expect(first).toBe(second);
    expect(parseFeedbackWorkerRegistrationName(first)).toEqual(profile);
    expect(
      attestFeedbackWorkers([workerInfo(first), workerInfo(second)], profile),
    ).toEqual({
      status: "verified",
      registeredWorkerCount: 2,
      malformedWorkerCount: 0,
      observedProfiles: [profile],
      issue: null,
    });
  });

  it("fails closed for a legacy or corrupt registered worker", () => {
    const profile = paidTerraProfile();
    const result = attestFeedbackWorkers(
      [
        workerInfo(createFeedbackWorkerRegistrationName(profile)),
        workerInfo("feedback-worker"),
      ],
      profile,
    );

    expect(result).toMatchObject({
      status: "malformed",
      registeredWorkerCount: 2,
      malformedWorkerCount: 1,
      observedProfiles: [profile],
    });
  });

  it("rejects a valid worker whose stub/model controls differ from the API", () => {
    const expected = paidTerraProfile();
    const staleWorker = resolveFeedbackWorkerControlProfile({
      extractionStub: true,
      model: "qwen/qwen3.7-max",
      extractionReasoningEffort: "xhigh",
      replyReasoningEffort: "low",
      attentionReasoningEffort: "high",
      serviceTier: "priority",
    });

    expect(
      attestFeedbackWorkers(
        [workerInfo(createFeedbackWorkerRegistrationName(staleWorker))],
        expected,
      ),
    ).toMatchObject({
      status: "mismatch",
      registeredWorkerCount: 1,
      malformedWorkerCount: 0,
      observedProfiles: [
        {
          extractionStub: true,
          model: "qwen/qwen3.7-max",
          provider: "openrouter",
          providerModelId: "qwen/qwen3.7-max",
          extractionReasoningEffort: "xhigh",
          replyReasoningEffort: "low",
          attentionReasoningEffort: "high",
          serviceTier: null,
        },
      ],
    });
  });

  it("uses the same defaults and strict boolean vocabulary as environment validation", () => {
    const name = createFeedbackWorkerRegistrationNameFromEnvironment({
      FEEDBACK_EXTRACTION_STUB: " false ",
      FEEDBACK_EXTRACTION_MODEL: "openai/gpt-5.6-terra",
      FEEDBACK_EXTRACTION_REASONING_EFFORT: "medium",
      FEEDBACK_REPLY_REASONING_EFFORT: "low",
      FEEDBACK_ATTENTION_REASONING_EFFORT: "medium",
      FEEDBACK_EXTRACTION_SERVICE_TIER: "",
    });

    expect(parseFeedbackWorkerRegistrationName(name)).toEqual(
      paidTerraProfile(),
    );
    expect(() =>
      createFeedbackWorkerRegistrationNameFromEnvironment({
        FEEDBACK_EXTRACTION_STUB: "1",
      }),
    ).toThrow("FEEDBACK_EXTRACTION_STUB must be true or false");
  });
});

function paidTerraProfile() {
  return resolveFeedbackWorkerControlProfile({
    extractionStub: false,
    model: "openai/gpt-5.6-terra",
    extractionReasoningEffort: "medium",
    replyReasoningEffort: "low",
    attentionReasoningEffort: "medium",
    serviceTier: undefined,
  });
}

function workerInfo(registrationName: string): { rawname: string } {
  return {
    rawname: `bull:ZmVlZGJhY2s=:w:${registrationName}`,
  };
}
