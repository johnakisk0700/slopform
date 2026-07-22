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
const optionalCredential = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .min(1)
    .max(512)
    .refine(
      (value) => value === value.trim(),
      "Credential must not have leading or trailing whitespace",
    )
    .refine(
      (value) => !/[\r\n]/u.test(value),
      "Credential must not contain line breaks",
    )
    .optional(),
);
const webOrigins = z
  .string()
  .default("http://localhost:3000")
  .transform((value, context) => {
    const origins = value.split(",").map((origin) => origin.trim());
    const normalizedOrigins: string[] = [];

    for (const [index, origin] of origins.entries()) {
      try {
        const url = new URL(origin);

        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        ) {
          throw new Error("not an HTTP origin");
        }

        normalizedOrigins.push(url.origin);
      } catch {
        context.addIssue({
          code: "custom",
          message: `WEB_ORIGIN entry ${index + 1} must be an HTTP(S) origin`,
        });
      }
    }

    return [...new Set(normalizedOrigins)];
  });
const postgresUrl = z.url().refine((value) => {
  const url = parseUrl(value);
  return !url || ["postgres:", "postgresql:"].includes(url.protocol);
}, "Expected a PostgreSQL URL");
const redisUrl = z.url().refine((value) => {
  const url = parseUrl(value);
  return !url || ["redis:", "rediss:"].includes(url.protocol);
}, "Expected a Redis URL");
const booleanFromEnvironment = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
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

export const environmentSchema = observabilityEnvironmentSchema
  .safeExtend({
    API_HOST: z.string().trim().min(1).max(253).default("0.0.0.0"),
    API_PORT: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(65_535).default(4000),
    ),
    WEB_ORIGIN: webOrigins,
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(100).default(10),
    ),
    REDIS_URL: redisUrl.default("redis://localhost:6379"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    BULL_BOARD_ENABLED: booleanFromEnvironment,
    BULL_BOARD_USERNAME: optionalCredential,
    BULL_BOARD_PASSWORD: optionalCredential,
    REFERENCE_MODULE_ENABLED: booleanFromEnvironment,
  })
  .superRefine((environment, context) => {
    if (environment.BULL_BOARD_ENABLED) {
      if (
        !environment.BULL_BOARD_USERNAME ||
        !environment.BULL_BOARD_PASSWORD
      ) {
        context.addIssue({
          code: "custom",
          message:
            "BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD are required when Bull Board is enabled",
          path: ["BULL_BOARD_ENABLED"],
        });
      }

      if (environment.BULL_BOARD_USERNAME?.includes(":")) {
        context.addIssue({
          code: "custom",
          message: "BULL_BOARD_USERNAME must not contain a colon",
          path: ["BULL_BOARD_USERNAME"],
        });
      }

      if (
        environment.BULL_BOARD_PASSWORD &&
        environment.BULL_BOARD_PASSWORD.length < 16
      ) {
        context.addIssue({
          code: "custom",
          message:
            "BULL_BOARD_PASSWORD must contain at least 16 characters when Bull Board is enabled",
          path: ["BULL_BOARD_PASSWORD"],
        });
      }
    }

    if (
      environment.NODE_ENV === "production" &&
      environment.WEB_ORIGIN.some(
        (origin) => new URL(origin).protocol !== "https:",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "WEB_ORIGIN entries must use HTTPS in production",
        path: ["WEB_ORIGIN"],
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  return environmentSchema.parse(input);
}

export function validateObservabilityEnvironment(
  input: Record<string, unknown>,
): ObservabilityEnvironment {
  return observabilityEnvironmentSchema.parse(input);
}

export function isBullBoardEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.BULL_BOARD_ENABLED?.trim().toLowerCase() === "true";
}

export function isReferenceModuleEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.REFERENCE_MODULE_ENABLED?.trim().toLowerCase() === "true";
}
