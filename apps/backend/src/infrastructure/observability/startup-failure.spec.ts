import { describe, expect, it, vi } from "vitest";

import {
  handleStartupFailure,
  serializeStartupError,
} from "./startup-failure.js";

describe("handleStartupFailure", () => {
  it.each(["http.bootstrap.failed", "worker.bootstrap.failed"] as const)(
    "coordinates %s exactly once",
    async (event) => {
      const calls: string[] = [];
      const error = new Error("listen failed");
      const capture = vi.fn(() => calls.push("capture"));
      const closeApplication = vi.fn(async () => {
        calls.push("close");
      });
      const shutdownTelemetry = vi.fn(async () => {
        calls.push("shutdown");
      });
      const writeFatalEvent = vi.fn(() => calls.push("write"));

      await handleStartupFailure(error, {
        capture,
        closeApplication,
        event,
        shutdownTelemetry,
        writeFatalEvent,
      });

      expect(capture).toHaveBeenCalledOnce();
      expect(capture).toHaveBeenCalledWith(error);
      expect(closeApplication).toHaveBeenCalledOnce();
      expect(shutdownTelemetry).toHaveBeenCalledOnce();
      expect(writeFatalEvent).toHaveBeenCalledWith(event, error);
      expect(calls).toEqual(["capture", "close", "write", "shutdown"]);
    },
  );

  it("reports cleanup failures without recapturing the startup error", async () => {
    const error = new Error("listen failed");
    const closeError = new Error("close failed");
    const capture = vi.fn();
    const writeFatalEvent = vi.fn();

    await handleStartupFailure(error, {
      capture,
      closeApplication: vi.fn().mockRejectedValue(closeError),
      event: "http.bootstrap.failed",
      shutdownTelemetry: vi.fn().mockRejectedValue(new Error("flush failed")),
      writeFatalEvent,
    });

    expect(capture).toHaveBeenCalledOnce();
    const reportedError = writeFatalEvent.mock.calls[0]?.[1];
    expect(reportedError).toBeInstanceOf(AggregateError);
    expect((reportedError as AggregateError).errors).toEqual([
      error,
      closeError,
    ]);
    expect(writeFatalEvent).toHaveBeenNthCalledWith(
      2,
      "telemetry.shutdown.failed",
      expect.any(Error),
    );

    expect(serializeStartupError(reportedError)).toMatchObject({
      errors: [
        { message: "listen failed", name: "Error" },
        { message: "close failed", name: "Error" },
      ],
      message: "Application startup failed and cleanup also failed",
      name: "AggregateError",
    });
  });

  it("still closes the application and flushes when exception capture fails", async () => {
    const calls: string[] = [];
    const error = new Error("listen failed");
    const captureError = new Error("capture failed");
    const writeFatalEvent = vi.fn((event: string) => calls.push(event));

    await handleStartupFailure(error, {
      capture: vi.fn(() => {
        calls.push("capture");
        throw captureError;
      }),
      closeApplication: vi.fn(async () => {
        calls.push("close");
      }),
      event: "http.bootstrap.failed",
      shutdownTelemetry: vi.fn(async () => {
        calls.push("shutdown");
      }),
      writeFatalEvent,
    });

    expect(writeFatalEvent).toHaveBeenNthCalledWith(
      1,
      "telemetry.capture.failed",
      captureError,
    );
    expect(writeFatalEvent).toHaveBeenNthCalledWith(
      2,
      "http.bootstrap.failed",
      error,
    );
    expect(calls).toEqual([
      "capture",
      "telemetry.capture.failed",
      "close",
      "http.bootstrap.failed",
      "shutdown",
    ]);
  });

  it("redacts userinfo and query values in common service URLs", () => {
    const serialized = serializeStartupError(
      new Error(
        "postgresql://database-user:database-password@database:5432/app?password=query-password&sslmode=require redis://:redis-password@redis:6379",
      ),
    );
    const output = JSON.stringify(serialized);

    expect(output).not.toContain("database-password");
    expect(output).not.toContain("query-password");
    expect(output).not.toContain("redis-password");
    expect(output).not.toContain("sslmode=require");
    expect(output).toContain("sslmode=[Redacted]");
    expect(output).toContain("[Redacted]");
  });
});
