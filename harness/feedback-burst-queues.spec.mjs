import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveFeedbackBurstQueueNames } from "./feedback-burst-queues.mjs";

describe("resolveFeedbackBurstQueueNames", () => {
  it("covers legacy drain, ingress materialization and V2 reconciliation", () => {
    assert.deepEqual(
      resolveFeedbackBurstQueueNames({
        FEEDBACK_QUEUE: "feedback",
        FEEDBACK_INGRESS_QUEUE: "feedback-ingress",
        FEEDBACK_CONVERSATION_QUEUE: "feedback-conversation",
      }),
      ["feedback", "feedback-ingress", "feedback-conversation"],
    );
  });

  it("fails closed against stale or colliding built constants", () => {
    assert.throws(
      () =>
        resolveFeedbackBurstQueueNames({
          FEEDBACK_QUEUE: "feedback",
          FEEDBACK_INGRESS_QUEUE: "feedback-ingress",
        }),
      /rebuild apps\/backend\/dist/u,
    );
    assert.throws(
      () =>
        resolveFeedbackBurstQueueNames({
          FEEDBACK_QUEUE: "feedback",
          FEEDBACK_INGRESS_QUEUE: "feedback",
          FEEDBACK_CONVERSATION_QUEUE: "feedback-conversation",
        }),
      /distinct queues/u,
    );
  });
});
