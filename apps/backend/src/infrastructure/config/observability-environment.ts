import { z } from "zod";

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};
const httpUrl = z.url().refine((value) => {
  const url = parseUrl(value);
  return !url || ["http:", "https:"].includes(url.protocol);
}, "Expected an HTTP(S) URL");
const optionalHttpUrl = z.preprocess(
  emptyStringToUndefined,
  httpUrl.optional(),
);
const optionalOtlpEndpoint = z.preprocess(
  emptyStringToUndefined,
  httpUrl
    .refine((value) => {
      const url = parseUrl(value);
      return !url || (!url.username && !url.password);
    }, "OTLP endpoint credentials must not be embedded in the URL")
    .refine((value) => {
      const url = parseUrl(value);
      return !url || (!url.search && !url.hash);
    }, "OTLP endpoint must not include a query string or fragment")
    .optional(),
);
const nodeEnvironment = z
  .enum(["development", "test", "production"])
  .default("development");
const otelServiceName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .default("join-the-six-api");
const sentryTracesSampleRate = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().min(0).max(1).default(0.1),
);

/**
 * Keep this schema dependency-light: the instrumentation preload imports it
 * before OpenTelemetry installs hooks for database and provider libraries.
 */
export const observabilityEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironment,
    OTEL_SERVICE_NAME: otelServiceName,
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalOtlpEndpoint,
    SENTRY_DSN: optionalHttpUrl,
    SENTRY_TRACES_SAMPLE_RATE: sentryTracesSampleRate,
  })
  .superRefine((environment, context) => {
    if (environment.OTEL_EXPORTER_OTLP_ENDPOINT && environment.SENTRY_DSN) {
      context.addIssue({
        code: "custom",
        message:
          "Configure either the OpenTelemetry OTLP exporter or Sentry tracing, not both",
        path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
      });
    }
  });

export type ObservabilityEnvironment = z.infer<
  typeof observabilityEnvironmentSchema
>;

export function validateObservabilityEnvironment(
  input: Record<string, unknown>,
): ObservabilityEnvironment {
  return observabilityEnvironmentSchema.parse(input);
}
