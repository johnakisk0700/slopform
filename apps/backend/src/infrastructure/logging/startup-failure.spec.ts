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
      const closeApplication = vi.fn(async () => {
        calls.push("close");
      });
      const writeFatalEvent = vi.fn(() => calls.push("write"));

      await handleStartupFailure(error, {
        closeApplication,
        event,
        writeFatalEvent,
      });

      expect(closeApplication).toHaveBeenCalledOnce();
      expect(writeFatalEvent).toHaveBeenCalledWith(event, error);
      expect(calls).toEqual(["close", "write"]);
    },
  );

  it("reports both the startup error and cleanup failure", async () => {
    const error = new Error("listen failed");
    const closeError = new Error("close failed");
    const writeFatalEvent = vi.fn();

    await handleStartupFailure(error, {
      closeApplication: vi.fn().mockRejectedValue(closeError),
      event: "http.bootstrap.failed",
      writeFatalEvent,
    });

    const reportedError = writeFatalEvent.mock.calls[0]?.[1];
    expect(reportedError).toBeInstanceOf(AggregateError);
    expect((reportedError as AggregateError).errors).toEqual([
      error,
      closeError,
    ]);
    expect(writeFatalEvent).toHaveBeenCalledOnce();

    expect(serializeStartupError(reportedError)).toMatchObject({
      errors: [
        { message: "listen failed", name: "Error" },
        { message: "close failed", name: "Error" },
      ],
      message: "Application startup failed and cleanup also failed",
      name: "AggregateError",
    });
  });

  it("reports failures before an application context exists", async () => {
    const error = new Error("configuration invalid");
    const writeFatalEvent = vi.fn();
    await handleStartupFailure(error, {
      event: "http.bootstrap.failed",
      writeFatalEvent,
    });
    expect(writeFatalEvent).toHaveBeenCalledExactlyOnceWith(
      "http.bootstrap.failed",
      error,
    );
  });

  it("redacts userinfo and query values in common service URLs", () => {
    const serialized = serializeStartupError(
      new Error(
        "postgresql://database-user:database-password@database:5432/app?password=query-password&sslmode=require redis://:redis-password@redis:6379 mongodb://mongo-user:mongo-password@mongo:27017/app mongodb+srv://srv-user:srv-password@cluster.example/app",
      ),
    );
    const output = JSON.stringify(serialized);

    expect(output).not.toContain("database-password");
    expect(output).not.toContain("query-password");
    expect(output).not.toContain("redis-password");
    expect(output).not.toContain("mongo-password");
    expect(output).not.toContain("srv-password");
    expect(output).not.toContain("sslmode=require");
    expect(output).toContain("sslmode=[Redacted]");
    expect(output).toContain("[Redacted]");
  });
});
