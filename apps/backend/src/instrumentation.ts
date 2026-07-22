import "dotenv/config";

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as Sentry from "@sentry/nestjs";

let openTelemetrySdk: NodeSDK | undefined;

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(
  /\/$/,
  "",
);
const sentryDsn = process.env.SENTRY_DSN;

if (otlpEndpoint && sentryDsn) {
  throw new Error(
    "Configure either OTEL_EXPORTER_OTLP_ENDPOINT or SENTRY_DSN, not both",
  );
}

if (otlpEndpoint) {
  openTelemetrySdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName: process.env.OTEL_SERVICE_NAME ?? "join-the-six-api",
    traceExporter: new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`,
    }),
  });
  openTelemetrySdk.start();
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  });
}

export async function shutdownTelemetry(): Promise<void> {
  await Promise.all([
    openTelemetrySdk?.shutdown(),
    sentryDsn ? Sentry.close(2_000) : Promise.resolve(true),
  ]);
}
