import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessFeedbackBurstIntroReadiness } from "./feedback-burst-intro-readiness.mjs";

const target = {
  phoneE164: "+306900000101",
  conversationId: "conversation-current",
};

describe("assessFeedbackBurstIntroReadiness", () => {
  it("requires the sink row for the current conversation's exact intro outbox", () => {
    const current = {
      id: "outbox-current",
      conversationId: target.conversationId,
      status: "sent",
    };

    assert.deepEqual(
      assessFeedbackBurstIntroReadiness({
        targets: [target],
        introRows: [current],
        sinkRows: [{ outboxId: "outbox-from-an-old-phone-rehearsal" }],
      }),
      {
        ready: false,
        pending: [
          {
            ...target,
            outboxId: current.id,
            reason: "intro_sink_missing",
          },
        ],
        terminal: [],
      },
    );

    assert.equal(
      assessFeedbackBurstIntroReadiness({
        targets: [target],
        introRows: [current],
        sinkRows: [{ outboxId: current.id }],
      }).ready,
      true,
    );
  });

  it("fails fast for every terminal intro outcome, including ambiguity with a sink", () => {
    for (const status of ["failed", "cancelled", "ambiguous"]) {
      const result = assessFeedbackBurstIntroReadiness({
        targets: [target],
        introRows: [
          {
            id: `outbox-${status}`,
            conversationId: target.conversationId,
            status,
          },
        ],
        sinkRows: [{ outboxId: `outbox-${status}` }],
      });

      assert.equal(result.ready, false);
      assert.deepEqual(result.pending, []);
      assert.equal(result.terminal[0].reason, `intro_${status}`);
    }
  });

  it("keeps ordinary in-flight states pending and rejects duplicate intro intents", () => {
    const pending = assessFeedbackBurstIntroReadiness({
      targets: [target],
      introRows: [
        {
          id: "outbox-current",
          conversationId: target.conversationId,
          status: "attempting",
        },
      ],
      sinkRows: [],
    });
    assert.equal(pending.pending[0].reason, "intro_attempting");

    const duplicate = assessFeedbackBurstIntroReadiness({
      targets: [target],
      introRows: [
        {
          id: "outbox-1",
          conversationId: target.conversationId,
          status: "sent",
        },
        {
          id: "outbox-2",
          conversationId: target.conversationId,
          status: "sent",
        },
      ],
      sinkRows: [],
    });
    assert.equal(duplicate.terminal[0].reason, "multiple_intro_outboxes");
  });
});
