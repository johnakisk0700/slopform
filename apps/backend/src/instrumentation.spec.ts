import { afterEach, describe, expect, it, vi } from "vitest";

const preloadEvents = vi.hoisted(() => [] as string[]);

vi.mock("mongodb", () => {
  preloadEvents.push("mongodb.import");
  return { MongoClient: class MongoClient {} };
});
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: () => [],
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class OTLPTraceExporter {},
}));
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class NodeSDK {
    start(): void {
      preloadEvents.push("sdk.start");
    }

    shutdown(): Promise<void> {
      preloadEvents.push("sdk.shutdown");
      return Promise.resolve();
    }
  },
}));
vi.mock("@sentry/nestjs", () => ({
  captureException: vi.fn(),
  close: vi.fn().mockResolvedValue(true),
  init: vi.fn(),
}));

describe("instrumentation preload dependencies", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    preloadEvents.length = 0;
  });

  it("starts OpenTelemetry without preloading the MongoDB driver", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.example.com");
    vi.stubEnv("OTEL_SERVICE_NAME", "join-the-six-test");
    vi.stubEnv("SENTRY_DSN", "");

    const instrumentation = await import("./instrumentation.js");

    expect(preloadEvents).toEqual(["sdk.start"]);

    await instrumentation.shutdownTelemetry();
    expect(preloadEvents).toEqual(["sdk.start", "sdk.shutdown"]);
  });
});
