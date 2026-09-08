import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApplication } from "./bootstrap-http.js";

vi.mock("./http-app.module.js", () => ({ HttpAppModule: class {} }));

afterEach(() => vi.restoreAllMocks());

describe("HTTP startup cleanup", () => {
  it("closes the created application when configuration fails", async () => {
    const error = new Error("HTTP configuration failed");
    const app = {
      get: vi.fn(() => {
        throw error;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(NestFactory, "create").mockResolvedValue(
      app as unknown as NestExpressApplication,
    );

    await expect(createHttpApplication()).rejects.toBe(error);
    expect(app.close).toHaveBeenCalledOnce();
  });
});
