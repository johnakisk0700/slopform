import { describe, expect, it } from "vitest";

import {
  isBullBoardEnabled,
  isReferenceModuleEnabled,
  validateEnvironment,
  validateObservabilityEnvironment,
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

  it("requires unambiguous, non-trivial Bull Board credentials", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        BULL_BOARD_ENABLED: "true",
        BULL_BOARD_PASSWORD: "too-short",
        BULL_BOARD_USERNAME: "operator:name",
      }),
    ).toThrow(/BULL_BOARD_USERNAME/);

    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        BULL_BOARD_ENABLED: "true",
        BULL_BOARD_PASSWORD: "too-short",
        BULL_BOARD_USERNAME: "operator",
      }),
    ).toThrow(/at least 16 characters/);
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

  it("validates preload observability settings without requiring app dependencies", () => {
    expect(
      validateObservabilityEnvironment({
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com/otel/",
        OTEL_SERVICE_NAME: " join-the-six-api ",
        SENTRY_TRACES_SAMPLE_RATE: "0.25",
      }),
    ).toMatchObject({
      NODE_ENV: "production",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com/otel/",
      OTEL_SERVICE_NAME: "join-the-six-api",
      SENTRY_TRACES_SAMPLE_RATE: 0.25,
    });
  });

  it("rejects unsafe telemetry endpoint forms", () => {
    expect(() =>
      validateObservabilityEnvironment({
        OTEL_EXPORTER_OTLP_ENDPOINT:
          "https://operator:secret@collector.example.com/otel",
      }),
    ).toThrow(/credentials must not be embedded/);

    expect(() =>
      validateObservabilityEnvironment({ SENTRY_DSN: "file:///tmp/sentry" }),
    ).toThrow(/HTTP\(S\)/);
  });

  it.each([
    ["DATABASE_URL", "not-a-database-url"],
    ["REDIS_URL", "not-a-redis-url"],
  ] as const)("reports malformed %s through Zod", (key, value) => {
    expect(() =>
      validateEnvironment({ ...requiredEnvironment, [key]: value }),
    ).toThrow(/Invalid URL/);
  });

  it("reports a malformed telemetry URL through Zod", () => {
    expect(() =>
      validateObservabilityEnvironment({
        OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-telemetry-url",
      }),
    ).toThrow(/Invalid URL/);
  });

  it("requires HTTPS browser origins in production", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: "production",
        WEB_ORIGIN: "http://app.example.com",
      }),
    ).toThrow(/HTTPS in production/);
  });

  it("enables optional modules only for an explicit true flag", () => {
    expect(isBullBoardEnabled({ BULL_BOARD_ENABLED: " TRUE " })).toBe(true);
    expect(isBullBoardEnabled({})).toBe(false);
    expect(
      isReferenceModuleEnabled({ REFERENCE_MODULE_ENABLED: "false" }),
    ).toBe(false);
  });
});
