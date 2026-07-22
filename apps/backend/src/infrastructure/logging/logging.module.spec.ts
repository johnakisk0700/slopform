import pino from "pino";
import type { Options as PinoHttpOptions } from "pino-http";
import { describe, expect, it, vi } from "vitest";

import {
  isLivenessRequest,
  requestPath,
} from "../observability/http-observability.js";
import {
  createLoggingParameters,
  validIncomingRequestId,
} from "./logging.module.js";

function optionsFor(
  nodeEnvironment: "development" | "production" = "development",
  pretty = false,
): PinoHttpOptions {
  const options = createLoggingParameters(
    { LOG_LEVEL: "info", NODE_ENV: nodeEnvironment },
    pretty,
  ).pinoHttp;

  if (!options || Array.isArray(options) || typeof options !== "object") {
    throw new Error("Expected pino-http options");
  }

  return options as PinoHttpOptions;
}

describe("LoggingModule configuration", () => {
  it("accepts only bounded, log-safe incoming request IDs", () => {
    expect(validIncomingRequestId("request-1.A_B")).toBe("request-1.A_B");
    expect(validIncomingRequestId("request id")).toBeUndefined();
    expect(validIncomingRequestId("request\nforged")).toBeUndefined();
    expect(validIncomingRequestId("x".repeat(129))).toBeUndefined();
    expect(validIncomingRequestId(["request-1"])).toBeUndefined();
  });

  it("removes query values from logs and suppresses only liveness noise", () => {
    expect(requestPath("/api/v1/reference?token=secret#fragment")).toBe(
      "/api/v1/reference",
    );
    expect(isLivenessRequest("/api/v1/health/live?probe=1")).toBe(true);
    expect(isLivenessRequest("/api/v1/health/ready")).toBe(false);

    const autoLogging = optionsFor().autoLogging;
    expect(typeof autoLogging).toBe("object");
    expect(
      typeof autoLogging === "object"
        ? autoLogging.ignore?.({ url: "/api/v1/health/live" } as never)
        : undefined,
    ).toBe(true);
  });

  it("preserves valid correlation IDs and replaces invalid ones", () => {
    const options = optionsFor();
    const setHeader = vi.fn();

    expect(
      options.genReqId?.(
        { headers: { "x-request-id": "upstream-123" } } as never,
        { setHeader } as never,
      ),
    ).toBe("upstream-123");
    expect(setHeader).toHaveBeenCalledWith("x-request-id", "upstream-123");

    const generated = options.genReqId?.(
      { headers: { "x-request-id": "not valid" } } as never,
      { setHeader } as never,
    );
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("uses readable development output only for an interactive terminal", () => {
    expect(optionsFor("development", true).transport).toMatchObject({
      target: "pino-pretty",
    });
    expect(optionsFor("development", false).transport).toBeUndefined();
    expect(optionsFor("production", true).transport).toBeUndefined();
  });

  it("adds trace context at log time instead of binding stale request spans", () => {
    const options = optionsFor();

    expect(options.customProps).toBeUndefined();
    expect(options.mixin?.({}, 30, {} as never)).toEqual({});
  });

  it("redacts common application-level credentials", () => {
    const redact = optionsFor().redact;
    let output = "";
    expect(redact).toBeDefined();
    const logger = pino(
      { ...(redact ? { redact } : {}) },
      {
        write: (chunk: string) => {
          output += chunk;
        },
      },
    );

    logger.info({
      password: "top-level-password",
      nested: { token: "nested-token" },
    });

    expect(output).not.toContain("top-level-password");
    expect(output).not.toContain("nested-token");
    expect(output).toContain("[Redacted]");
  });
});
