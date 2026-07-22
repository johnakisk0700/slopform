import { describe, expect, it } from "vitest";

import { validateEnvironment } from "./environment.js";

const requiredEnvironment = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/join_the_six",
};

describe("validateEnvironment", () => {
  it("coerces safe defaults and numbers", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      API_PORT: "4100",
    });

    expect(environment.API_PORT).toBe(4100);
    expect(environment.BULL_BOARD_ENABLED).toBe(false);
    expect(environment.REDIS_URL).toBe("redis://localhost:6379");
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
});
