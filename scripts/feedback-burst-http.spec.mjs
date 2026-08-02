import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createFeedbackBurstIdempotencyKey,
  requestFeedbackBurstJson,
} from "./feedback-burst-http.mjs";

describe("feedback burst HTTP", () => {
  it("builds bounded deterministic keys per scripted message", () => {
    const first = createFeedbackBurstIdempotencyKey({
      correlationId: "run-1",
      personaId: "slow_typist",
      messageIndex: 2,
    });
    const repeated = createFeedbackBurstIdempotencyKey({
      correlationId: "run-1",
      personaId: "slow_typist",
      messageIndex: 2,
    });
    const next = createFeedbackBurstIdempotencyKey({
      correlationId: "run-1",
      personaId: "slow_typist",
      messageIndex: 3,
    });

    assert.equal(first, repeated);
    assert.notEqual(first, next);
    assert.match(first, /^burst-[a-f0-9]{64}$/u);
    assert.ok(first.length <= 128);
  });

  it("retries an opted-in network failure with the exact same request", async () => {
    const calls = [];
    const init = { method: "POST", body: '{"idempotencyKey":"stable"}' };
    const result = await requestFeedbackBurstJson(
      "https://example.test",
      init,
      {
        transientRetries: 2,
        sleepImpl: async () => {},
        fetchImpl: async (_url, receivedInit) => {
          calls.push(receivedInit);
          if (calls.length === 1) {
            throw new TypeError("fetch failed");
          }
          return Response.json({ ok: true });
        },
      },
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
    assert.strictEqual(calls[0], init);
    assert.strictEqual(calls[1], init);
  });

  it("retries transient HTTP responses but not ordinary client errors", async () => {
    let transientCalls = 0;
    const recovered = await requestFeedbackBurstJson(
      "https://example.test",
      {},
      {
        transientRetries: 1,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          transientCalls += 1;
          return transientCalls === 1
            ? Response.json({ message: "busy" }, { status: 503 })
            : Response.json({ ok: true });
        },
      },
    );
    assert.deepEqual(recovered, { ok: true });
    assert.equal(transientCalls, 2);

    let clientErrorCalls = 0;
    await assert.rejects(
      requestFeedbackBurstJson(
        "https://example.test",
        {},
        {
          transientRetries: 3,
          sleepImpl: async () => {},
          fetchImpl: async () => {
            clientErrorCalls += 1;
            return Response.json({ message: "bad request" }, { status: 400 });
          },
        },
      ),
      /bad request/,
    );
    assert.equal(clientErrorCalls, 1);
  });
});
