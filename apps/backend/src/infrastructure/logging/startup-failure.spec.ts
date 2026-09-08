import { describe, expect, it, vi } from "vitest";

import {
  closeFailedApplication,
  serializeStartupError,
} from "./startup-failure.js";

describe("startup failure", () => {
  it("closes the application and preserves the original failure", async () => {
    const error = new Error("listen failed");
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(closeFailedApplication(app, error)).rejects.toBe(error);
    expect(app.close).toHaveBeenCalledOnce();
  });

  it("preserves the startup error when cleanup also fails", async () => {
    const error = new Error("listen failed");
    const closeError = new Error("close failed");
    const app = { close: vi.fn().mockRejectedValue(closeError) };
    await expect(closeFailedApplication(app, error)).rejects.toMatchObject({
      errors: [error, closeError],
    });
    expect(
      serializeStartupError(new AggregateError([error, closeError])),
    ).toMatchObject({
      errors: [{ message: "listen failed" }, { message: "close failed" }],
    });
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
