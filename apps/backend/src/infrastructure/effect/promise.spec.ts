import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { attemptPromise, runWithOriginalError } from "./promise.js";

describe("Effect / Promise boundary", () => {
  it("starts a service call only when the flow runs, once, and returns its value", async () => {
    const value = { id: "completed" };
    const call = vi.fn().mockResolvedValue(value);
    const flow = attemptPromise(call);
    expect(call).not.toHaveBeenCalled();
    await expect(runWithOriginalError(flow)).resolves.toBe(value);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    new TypeError("service failed"),
    "primitive failure",
    null,
    undefined,
  ])("preserves a rejected value: %s", async (failure) => {
    await expect(
      runWithOriginalError(attemptPromise(() => Promise.reject(failure))),
    ).rejects.toBe(failure);
  });

  it("preserves synchronous service throws so typed recovery can match them", async () => {
    const failure = new RangeError("capacity reached");
    const recover = vi.fn((_error: RangeError) => Effect.succeed("recovered"));
    const flow = attemptPromise(() => {
      throw failure;
    }).pipe(Effect.catchIf((error) => error instanceof RangeError, recover));
    await expect(runWithOriginalError(flow)).resolves.toBe("recovered");
    expect(recover).toHaveBeenCalledWith(failure);
  });

  it("preserves unexpected synchronous failures inside a recipe", async () => {
    const failure = new Error("unexpected failure");
    const flow = Effect.gen(function* () {
      yield* Effect.void;
      throw failure;
    });
    await expect(runWithOriginalError(flow)).rejects.toBe(failure);
  });
});
