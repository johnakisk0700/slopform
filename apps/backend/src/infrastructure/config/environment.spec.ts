import { describe, expect, it } from "vitest";

import {
  isBullBoardEnabled,
  isFeedbackSimulatorHttpEnabled,
  isReferenceModuleEnabled,
  isWasenderTransportEnabled,
  isWasenderWebhookEnabled,
} from "./enabled-modules.js";
import { validateEnvironment } from "./environment.js";
import { validateObservabilityEnvironment } from "./observability-environment.js";

const requiredEnvironment = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/join_the_six",
  MONGODB_URI: "mongodb://localhost:27017/join_the_six",
};

const productionEnvironment = {
  ...requiredEnvironment,
  NODE_ENV: "production",
  WEB_ORIGIN: "https://admin.example.com",
  TRANSPORT_MODE: "wasender",
  WASENDER_SESSION_API_KEY: "session-key",
} as const;

describe("validateEnvironment", () => {
  it("coerces safe defaults and numbers", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      API_PORT: "4100",
      WEB_ORIGIN: "https://app.example.com/, http://localhost:3000",
    });

    expect(environment.API_PORT).toBe(4100);
    expect(environment.AUTH_DEV_BYPASS).toBe(false);
    expect(environment.BULL_BOARD_ENABLED).toBe(false);
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.OPENROUTER_API_KEY).toBeUndefined();
    expect(environment.WASENDER_SESSION_API_KEY).toBeUndefined();
    expect(environment.WASENDER_WEBHOOK_ENABLED).toBe(false);
    expect(environment.WASENDER_WEBHOOK_SECRET).toBeUndefined();
    expect(environment.TRANSPORT_MODE).toBe("simulated");
    expect(environment.FEEDBACK_SIMULATOR_ENABLED).toBe(false);
    expect(environment.FEEDBACK_EXTRACTION_STUB).toBe(false);
    expect(environment.FEEDBACK_REMINDER_AFTER_HOURS).toBe(24);
    expect(environment.FEEDBACK_EXPIRE_AFTER_HOURS).toBe(72);
    expect(environment.FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES).toBe(5);
    expect(environment.MONGODB_URI).toBe(
      "mongodb://localhost:27017/join_the_six",
    );
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

  it("accepts absent Clerk keys for non-HTTP process composition", () => {
    const environment = validateEnvironment(requiredEnvironment);

    expect(environment.CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(environment.CLERK_SECRET_KEY).toBeUndefined();
    expect(environment.CLERK_ADMIN_USER_IDS).toBeUndefined();
  });

  it("validates Clerk keys as an all-or-nothing pair", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        CLERK_PUBLISHABLE_KEY: "pk_test_example",
      }),
    ).toThrow(/must be configured together/);

    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        CLERK_PUBLISHABLE_KEY: "not-a-publishable-key",
        CLERK_SECRET_KEY: "not-a-secret-key",
      }),
    ).toThrow(/Clerk publishable key/);

    expect(
      validateEnvironment({
        ...requiredEnvironment,
        CLERK_PUBLISHABLE_KEY: "pk_test_example",
        CLERK_SECRET_KEY: "sk_test_example",
        CLERK_ADMIN_USER_IDS: "user_admin123, user_admin456,user_admin123",
      }),
    ).toMatchObject({
      CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_ADMIN_USER_IDS: ["user_admin123", "user_admin456"],
    });

    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        CLERK_ADMIN_USER_IDS: "admin@example.com",
      }),
    ).toThrow(/Clerk user ID/);
  });

  it("allows the auth bypass only outside production", () => {
    expect(
      validateEnvironment({
        ...requiredEnvironment,
        AUTH_DEV_BYPASS: "true",
      }).AUTH_DEV_BYPASS,
    ).toBe(true);

    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        AUTH_DEV_BYPASS: "true",
      }),
    ).toThrow(/AUTH_DEV_BYPASS/);
  });

  it("rejects simulated transport and the HTTP simulator in production", () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        TRANSPORT_MODE: "simulated",
      }),
    ).toThrow(/TRANSPORT_MODE=simulated is not allowed in production/);
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        FEEDBACK_SIMULATOR_ENABLED: "true",
      }),
    ).toThrow(/FEEDBACK_SIMULATOR_ENABLED cannot be enabled in production/);
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        FEEDBACK_EXTRACTION_STUB: "true",
      }),
    ).toThrow(/FEEDBACK_EXTRACTION_STUB cannot be enabled in production/);
  });

  it("requires simulated transport when the HTTP simulator is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "wasender",
        WASENDER_SESSION_API_KEY: "session-key",
      }),
    ).toThrow(/FEEDBACK_SIMULATOR_ENABLED requires TRANSPORT_MODE=simulated/);
  });

  it("requires the HTTP simulator when the extraction stub is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        FEEDBACK_EXTRACTION_STUB: "true",
        FEEDBACK_SIMULATOR_ENABLED: "false",
      }),
    ).toThrow(
      /FEEDBACK_EXTRACTION_STUB requires FEEDBACK_SIMULATOR_ENABLED=true/,
    );
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

  it("normalizes blank AI credentials and rejects unsafe values", () => {
    expect(
      validateEnvironment({
        ...requiredEnvironment,
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "   ",
      }),
    ).toMatchObject({
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    });

    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        OPENAI_API_KEY: " secret",
      }),
    ).toThrow(/leading or trailing whitespace/);
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        OPENROUTER_API_KEY: "secret\nsecond-line",
      }),
    ).toThrow(/line breaks/);
  });

  it("validates the opt-in Wasender webhook and credentials", () => {
    expect(
      validateEnvironment({
        ...requiredEnvironment,
        WASENDER_SESSION_API_KEY: "session-key",
        WASENDER_WEBHOOK_ENABLED: "true",
        WASENDER_WEBHOOK_SECRET: "a".repeat(32),
      }),
    ).toMatchObject({
      WASENDER_SESSION_API_KEY: "session-key",
      WASENDER_WEBHOOK_ENABLED: true,
      WASENDER_WEBHOOK_SECRET: "a".repeat(32),
    });

    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        WASENDER_WEBHOOK_ENABLED: "true",
      }),
    ).toThrow(/WASENDER_WEBHOOK_SECRET/);
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        WASENDER_WEBHOOK_SECRET: "too-short",
      }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        WASENDER_SESSION_API_KEY: "session-key\nleak",
      }),
    ).toThrow(/line breaks/);
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
    ["MONGODB_URI", "not-a-database-url"],
    ["REDIS_URL", "not-a-redis-url"],
  ] as const)("reports malformed %s through Zod", (key, value) => {
    expect(() =>
      validateEnvironment({ ...requiredEnvironment, [key]: value }),
    ).toThrow(/Invalid URL/);
  });

  it("requires a MongoDB database name and accepts SRV URLs", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        MONGODB_URI: "mongodb://localhost:27017",
      }),
    ).toThrow(/select a database/);

    expect(
      validateEnvironment({
        ...requiredEnvironment,
        MONGODB_URI:
          "mongodb+srv://cluster.example.com/join_the_six?retryWrites=true",
      }).MONGODB_URI,
    ).toContain("mongodb+srv://");
  });

  it("accepts driver-supported MongoDB replica-set seed lists", () => {
    expect(
      validateEnvironment({
        ...requiredEnvironment,
        MONGODB_URI:
          "mongodb://user:password@mongo-a.example.com:27017,mongo-b.example.com:27017/join_the_six?replicaSet=rs0&tls=true",
      }).MONGODB_URI,
    ).toContain("mongo-a.example.com:27017,mongo-b.example.com:27017");
  });

  it("requires authenticated verified-TLS MongoDB outside the production data network", () => {
    const production = productionEnvironment;

    expect(() =>
      validateEnvironment({
        ...production,
        MONGODB_URI: "mongodb://database.example.com/join_the_six",
      }),
    ).toThrow(/authenticated credentials/);
    expect(() =>
      validateEnvironment({
        ...production,
        MONGODB_URI:
          "mongodb://user:password@database.example.com/join_the_six?tls=true&tlsAllowInvalidCertificates=true",
      }),
    ).toThrow(/must not disable TLS certificate verification/);
    expect(() =>
      validateEnvironment({
        ...production,
        MONGODB_URI:
          "mongodb://user:password@database.example.com/join_the_six",
      }),
    ).toThrow(/requires TLS/);

    expect(
      validateEnvironment({
        ...production,
        MONGODB_URI:
          "mongodb://user:password@mongo:27017/join_the_six?authSource=join_the_six&retryWrites=false",
      }).MONGODB_URI,
    ).toContain("@mongo:27017/");
    expect(
      validateEnvironment({
        ...production,
        MONGODB_URI:
          "mongodb+srv://user:password@cluster.example.com/join_the_six",
      }).MONGODB_URI,
    ).toContain("mongodb+srv://");
    expect(
      validateEnvironment({
        ...production,
        MONGODB_URI:
          "mongodb://user:password@mongo-a.example.com:27017,mongo-b.example.com:27017/join_the_six?replicaSet=rs0&tls=true",
      }).MONGODB_URI,
    ).toContain("mongo-a.example.com:27017,mongo-b.example.com:27017");
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
        ...productionEnvironment,
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
    expect(
      isWasenderWebhookEnabled({ WASENDER_WEBHOOK_ENABLED: " TRUE " }),
    ).toBe(true);
    expect(isWasenderWebhookEnabled({})).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(true);
    expect(
      isWasenderTransportEnabled({ WASENDER_SESSION_API_KEY: "key" }),
    ).toBe(true);
    expect(isWasenderTransportEnabled({ WASENDER_SESSION_API_KEY: "  " })).toBe(
      false,
    );
    expect(isWasenderTransportEnabled({ TRANSPORT_MODE: "wasender" })).toBe(
      true,
    );
  });

  it("requires a Wasender session key when TRANSPORT_MODE=wasender", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        TRANSPORT_MODE: "wasender",
      }),
    ).toThrow(/WASENDER_SESSION_API_KEY is required/);

    expect(
      validateEnvironment({
        ...requiredEnvironment,
        TRANSPORT_MODE: "wasender",
        WASENDER_SESSION_API_KEY: "session-key",
      }).TRANSPORT_MODE,
    ).toBe("wasender");
  });
});
