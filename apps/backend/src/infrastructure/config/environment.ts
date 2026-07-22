import { z } from "zod";

const emptyStringToUndefined = (value: unknown): unknown =>
  value === "" ? undefined : value;
const optionalUrl = z.preprocess(emptyStringToUndefined, z.url().optional());
const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
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
const postgresUrl = z
  .url()
  .refine(
    (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    "Expected a PostgreSQL URL",
  );
const redisUrl = z
  .url()
  .refine(
    (value) => ["redis:", "rediss:"].includes(new URL(value).protocol),
    "Expected a Redis URL",
  );
const booleanFromEnvironment = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
);

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
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
    OTEL_SERVICE_NAME: z.string().min(1).default("join-the-six-api"),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
    SENTRY_DSN: optionalUrl,
    SENTRY_TRACES_SAMPLE_RATE: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().min(0).max(1).default(0.1),
    ),
    BULL_BOARD_ENABLED: booleanFromEnvironment,
    BULL_BOARD_USERNAME: optionalString,
    BULL_BOARD_PASSWORD: optionalString,
    REFERENCE_MODULE_ENABLED: booleanFromEnvironment,
  })
  .superRefine((environment, context) => {
    if (
      environment.BULL_BOARD_ENABLED &&
      (!environment.BULL_BOARD_USERNAME || !environment.BULL_BOARD_PASSWORD)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD are required when Bull Board is enabled",
        path: ["BULL_BOARD_ENABLED"],
      });
    }

    if (environment.OTEL_EXPORTER_OTLP_ENDPOINT && environment.SENTRY_DSN) {
      context.addIssue({
        code: "custom",
        message:
          "Configure either the OpenTelemetry OTLP exporter or Sentry tracing, not both",
        path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  return environmentSchema.parse(input);
}

export function isBullBoardEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.BULL_BOARD_ENABLED?.toLowerCase() === "true";
}

export function isReferenceModuleEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.REFERENCE_MODULE_ENABLED?.toLowerCase() === "true";
}
