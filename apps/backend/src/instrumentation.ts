import { SpanStatusCode, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as Sentry from "@sentry/nestjs";
import { config as loadEnvironmentFile } from "dotenv";

import {
  type ObservabilityEnvironment,
  validateObservabilityEnvironment,
} from "./infrastructure/config/observability-environment.js";
import { isLivenessRequest } from "./infrastructure/observability/http-observability.js";
import { writeStructuredFatalEvent } from "./infrastructure/observability/startup-failure.js";

let openTelemetrySdk: NodeSDK | undefined;
let telemetryShutdown: Promise<void> | undefined;

const OTEL_EXPORT_TIMEOUT_MILLISECONDS = 5_000;
const SENTRY_CLOSE_TIMEOUT_MILLISECONDS = 2_000;
const REDACTED_QUERY_PARAMETERS = [
  "sig",
  "Signature",
  "signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "access_token",
  "api_key",
  "code",
  "key",
  "password",
  "refresh_token",
  "secret",
  "token",
];

if (process.env.NODE_ENV !== "production") {
  loadEnvironmentFile({ quiet: true });
}

let environment: ObservabilityEnvironment;

try {
  environment = validateObservabilityEnvironment(process.env);
} catch (error) {
  writeStructuredFatalEvent("telemetry.preload.failed", error);
  process.exit(1);
}
const otlpEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(
  /\/$/,
  "",
);
const sentryDsn = environment.SENTRY_DSN;

if (otlpEndpoint) {
  openTelemetrySdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (request) =>
            isLivenessRequest(request.url),
          redactedQueryParams: REDACTED_QUERY_PARAMETERS,
        },
        // LoggingModule adds the same trace context for both supported tracing
        // paths, so the Pino instrumentation would only duplicate fields.
        "@opentelemetry/instrumentation-pino": { enabled: false },
      }),
    ],
    // This deployment contract exports traces only. Passing explicit empty
    // arrays prevents NodeSDK from silently creating OTLP metric/log exporters
    // from the generic endpoint environment variable.
    logRecordProcessors: [],
    metricReaders: [],
    serviceName: environment.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter({
      timeoutMillis: OTEL_EXPORT_TIMEOUT_MILLISECONDS,
      url: `${otlpEndpoint}/v1/traces`,
    }),
  });
  openTelemetrySdk.start();
}

if (sentryDsn) {
  Sentry.init({
    dataCollection: {
      cookies: false,
      databaseQueryData: false,
      frameContextLines: 5,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      httpBodies: [],
      httpHeaders: {
        request: { allow: ["content-type", "user-agent", "x-request-id"] },
        response: false,
      },
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    },
    dsn: sentryDsn,
    environment: environment.NODE_ENV,
    ignoreTransactions: [/\/health\/live$/u],
    tracesSampleRate: environment.SENTRY_TRACES_SAMPLE_RATE,
  });
}

export function captureStartupException(error: unknown): void {
  const capturedError =
    error instanceof Error ? error : new Error(String(error));

  if (openTelemetrySdk) {
    const span = trace
      .getTracer(environment.OTEL_SERVICE_NAME)
      .startSpan("process.startup.failure");
    span.recordException(capturedError);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: capturedError.message,
    });
    span.end();
  }

  if (sentryDsn) {
    Sentry.captureException(capturedError);
  }
}

async function performTelemetryShutdown(): Promise<void> {
  const results = await Promise.allSettled([
    openTelemetrySdk?.shutdown() ?? Promise.resolve(),
    sentryDsn
      ? Sentry.close(SENTRY_CLOSE_TIMEOUT_MILLISECONDS).then((flushed) => {
          if (!flushed) {
            throw new Error(
              "Sentry did not flush before its shutdown deadline",
            );
          }
        })
      : Promise.resolve(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(failures, "Telemetry shutdown failed");
  }
}

export function shutdownTelemetry(): Promise<void> {
  telemetryShutdown ??= performTelemetryShutdown();
  return telemetryShutdown;
}
