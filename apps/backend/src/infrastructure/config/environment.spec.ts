import { describe, expect, it } from "vitest";

import {
  isBullBoardEnabled,
  isReferenceModuleEnabled,
  validateEnvironment,
} from "./environment.js";

const requiredEnvironment = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/join_the_six",
};

describe("validateEnvironment", () => {
  it("coerces safe defaults and numbers", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      API_PORT: "4100",
      WEB_ORIGIN: "https://app.example.com/, http://localhost:3000",
    });

    expect(environment.API_PORT).toBe(4100);
    expect(environment.BULL_BOARD_ENABLED).toBe(false);
    expect(environment.REDIS_URL).toBe("redis://localhost:6379");
    expect(environment.WEB_ORIGIN).toEqual([
      "https://app.example.com",
      "http://localhost:3000",
    ]);
  });

  it("uses numeric defaults for blank environment values", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      API_PORT: "",
      DATABASE_POOL_MAX: "",
      SENTRY_TRACES_SAMPLE_RATE: "",
    });

    expect(environment.API_PORT).toBe(4000);
    expect(environment.DATABASE_POOL_MAX).toBe(10);
    expect(environment.SENTRY_TRACES_SAMPLE_RATE).toBe(0.1);
  });

  it("rejects paths and empty entries in WEB_ORIGIN", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        WEB_ORIGIN: "https://app.example.com/admin,",
      }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it("requires credentials when Bull Board is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        BULL_BOARD_ENABLED: "true",
      }),
    ).toThrow(/BULL_BOARD_USERNAME/);
  });

  it("prevents two tracing SDKs from instrumenting the same process", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
        SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      }),
    ).toThrow(/either the OpenTelemetry OTLP exporter or Sentry/);
  });

  it("enables optional modules only for an explicit true flag", () => {
    expect(isBullBoardEnabled({ BULL_BOARD_ENABLED: "TRUE" })).toBe(true);
    expect(isBullBoardEnabled({})).toBe(false);
    expect(
      isReferenceModuleEnabled({ REFERENCE_MODULE_ENABLED: "false" }),
    ).toBe(false);
  });
});
