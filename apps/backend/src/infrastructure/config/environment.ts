import { MongoClient } from "mongodb";
import { z } from "zod";

import { observabilityEnvironmentSchema } from "./observability-environment.js";

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};
interface ParsedMongoConnectionString {
  readonly protocol: "mongodb:" | "mongodb+srv:";
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly database: string | undefined;
  readonly hostnames: readonly string[];
  readonly searchParams: URLSearchParams;
}

const mongoOption = (
  searchParams: URLSearchParams,
  name: string,
): string | undefined => {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of searchParams) {
    if (key.toLowerCase() === normalizedName) {
      return value.toLowerCase();
    }
  }
  return undefined;
};
const parseMongoConnectionString = (
  value: string,
): ParsedMongoConnectionString | undefined => {
  const protocol = value.startsWith("mongodb://")
    ? ("mongodb:" as const)
    : value.startsWith("mongodb+srv://")
      ? ("mongodb+srv:" as const)
      : undefined;
  if (!protocol || value.includes("#")) {
    return undefined;
  }

  try {
    // The driver's parser supports replica-set seed lists, unlike WHATWG URL.
    new MongoClient(value);
  } catch {
    return undefined;
  }

  const schemeLength =
    protocol === "mongodb:" ? "mongodb://".length : "mongodb+srv://".length;
  const remainder = value.slice(schemeLength);
  const queryStart = remainder.indexOf("?");
  const addressAndPath =
    queryStart === -1 ? remainder : remainder.slice(0, queryStart);
  const query = queryStart === -1 ? "" : remainder.slice(queryStart + 1);
  const pathStart = addressAndPath.indexOf("/");
  const authority =
    pathStart === -1 ? addressAndPath : addressAndPath.slice(0, pathStart);
  const database =
    pathStart === -1
      ? undefined
      : addressAndPath.slice(pathStart + 1) || undefined;
  const credentialEnd = authority.lastIndexOf("@");
  const credentials =
    credentialEnd === -1 ? undefined : authority.slice(0, credentialEnd);
  const seeds =
    credentialEnd === -1 ? authority : authority.slice(credentialEnd + 1);
  const passwordStart = credentials?.indexOf(":") ?? -1;
  const username =
    credentials === undefined
      ? undefined
      : passwordStart === -1
        ? credentials
        : credentials.slice(0, passwordStart);
  const password =
    credentials === undefined || passwordStart === -1
      ? undefined
      : credentials.slice(passwordStart + 1);

  return {
    protocol,
    username: username || undefined,
    password: password || undefined,
    database,
    hostnames: seeds.split(",").map(mongoSeedHostname),
    searchParams: new URLSearchParams(query),
  };
};
const mongoSeedHostname = (seed: string): string => {
  if (seed.startsWith("[")) {
    const bracket = seed.indexOf("]");
    return seed.slice(1, bracket).toLowerCase();
  }
  const portSeparator = seed.lastIndexOf(":");
  return (portSeparator === -1 ? seed : seed.slice(0, portSeparator))
    .toLowerCase()
    .trim();
};
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
const optionalWebhookSecret = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .min(32, "Webhook secret must contain at least 32 characters")
    .max(512)
    .refine(
      (value) => value === value.trim() && !/[\r\n]/u.test(value),
      "Webhook secret must not contain surrounding whitespace or line breaks",
    )
    .optional(),
);
const optionalClerkPublishableKey = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .min(1)
    .max(512)
    .regex(/^pk_(?:test|live)_/u, "Expected a Clerk publishable key")
    .refine(
      (value) => value === value.trim() && !/[\r\n]/u.test(value),
      "Clerk key must not contain surrounding whitespace or line breaks",
    )
    .optional(),
);
const optionalClerkSecretKey = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .min(1)
    .max(512)
    .regex(/^sk_(?:test|live)_/u, "Expected a Clerk secret key")
    .refine(
      (value) => value === value.trim() && !/[\r\n]/u.test(value),
      "Clerk key must not contain surrounding whitespace or line breaks",
    )
    .optional(),
);
const optionalClerkAdminUserIds = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .transform((value) => [
      ...new Set(value.split(",").map((entry) => entry.trim())),
    ])
    .superRefine((userIds, context) => {
      if (userIds.length === 0 || userIds.length > 100) {
        context.addIssue({
          code: "custom",
          message: "Expected between 1 and 100 Clerk admin user IDs",
        });
      }

      for (const [index, userId] of userIds.entries()) {
        if (!/^user_[A-Za-z0-9]+$/u.test(userId)) {
          context.addIssue({
            code: "custom",
            message: `Entry ${index + 1} must be a Clerk user ID`,
          });
        }
      }
    })
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
const mongodbUrl = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    const parsed = parseMongoConnectionString(value);
    if (!parsed) {
      context.addIssue({
        code: "custom",
        message: "Invalid URL: expected a MongoDB connection string",
      });
      return;
    }
    if (!parsed.database) {
      context.addIssue({
        code: "custom",
        message: "MONGODB_URI must select a database",
      });
    }
  });
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
    MONGODB_URI: mongodbUrl,
    REDIS_URL: redisUrl.default("redis://localhost:6379"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CLERK_PUBLISHABLE_KEY: optionalClerkPublishableKey,
    CLERK_SECRET_KEY: optionalClerkSecretKey,
    CLERK_ADMIN_USER_IDS: optionalClerkAdminUserIds,
    AUTH_DEV_BYPASS: booleanFromEnvironment,
    OPENAI_API_KEY: optionalCredential,
    OPENROUTER_API_KEY: optionalCredential,
    WASENDER_SESSION_API_KEY: optionalCredential,
    WASENDER_WEBHOOK_ENABLED: booleanFromEnvironment,
    WASENDER_WEBHOOK_SECRET: optionalWebhookSecret,
    /**
     * Outbound feedback transport. `simulated` is the local-first default
     * (D2); `wasender` requires `WASENDER_SESSION_API_KEY`. WP8 replaces the
     * in-memory simulated sink with a durable one — do not point production
     * traffic at simulated.
     */
    TRANSPORT_MODE: z.preprocess(
      emptyStringToUndefined,
      z.enum(["simulated", "wasender"]).default("simulated"),
    ),
    BULL_BOARD_ENABLED: booleanFromEnvironment,
    BULL_BOARD_USERNAME: optionalCredential,
    BULL_BOARD_PASSWORD: optionalCredential,
    REFERENCE_MODULE_ENABLED: booleanFromEnvironment,
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === "production" && environment.AUTH_DEV_BYPASS) {
      context.addIssue({
        code: "custom",
        message: "AUTH_DEV_BYPASS cannot be enabled in production",
        path: ["AUTH_DEV_BYPASS"],
      });
    }

    if (
      Boolean(environment.CLERK_PUBLISHABLE_KEY) !==
      Boolean(environment.CLERK_SECRET_KEY)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must be configured together",
        path: ["CLERK_PUBLISHABLE_KEY"],
      });
    }

    if (
      environment.WASENDER_WEBHOOK_ENABLED &&
      !environment.WASENDER_WEBHOOK_SECRET
    ) {
      context.addIssue({
        code: "custom",
        message:
          "WASENDER_WEBHOOK_SECRET is required when the Wasender webhook is enabled",
        path: ["WASENDER_WEBHOOK_ENABLED"],
      });
    }

    if (
      environment.TRANSPORT_MODE === "wasender" &&
      !environment.WASENDER_SESSION_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        message:
          "WASENDER_SESSION_API_KEY is required when TRANSPORT_MODE=wasender",
        path: ["TRANSPORT_MODE"],
      });
    }

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

    const mongo = parseMongoConnectionString(environment.MONGODB_URI);
    if (mongo && environment.NODE_ENV === "production") {
      if (!mongo.username || !mongo.password) {
        context.addIssue({
          code: "custom",
          message: "Production MongoDB requires authenticated credentials",
          path: ["MONGODB_URI"],
        });
      }

      const unsafeOptions = [
        "tlsInsecure",
        "tlsAllowInvalidCertificates",
        "tlsAllowInvalidHostnames",
      ];
      if (
        unsafeOptions.some(
          (option) => mongoOption(mongo.searchParams, option) === "true",
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Production MongoDB must not disable TLS certificate verification",
          path: ["MONGODB_URI"],
        });
      }

      const tls =
        mongoOption(mongo.searchParams, "tls") ??
        mongoOption(mongo.searchParams, "ssl");
      const internalComposeMongo =
        mongo.hostnames.length === 1 && mongo.hostnames[0] === "mongo";
      if (
        (mongo.protocol === "mongodb+srv:" && tls === "false") ||
        (mongo.protocol === "mongodb:" &&
          !internalComposeMongo &&
          tls !== "true")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Production MongoDB outside the internal mongo service requires TLS",
          path: ["MONGODB_URI"],
        });
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  return environmentSchema.parse(input);
}

export function isBullBoardEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.BULL_BOARD_ENABLED?.trim().toLowerCase() === "true";
}

export function isReferenceModuleEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.REFERENCE_MODULE_ENABLED?.trim().toLowerCase() === "true";
}

export function isWasenderWebhookEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.WASENDER_WEBHOOK_ENABLED?.trim().toLowerCase() === "true";
}

export function isWasenderTransportEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    Boolean(environment.WASENDER_SESSION_API_KEY?.trim()) ||
    environment.TRANSPORT_MODE?.trim().toLowerCase() === "wasender"
  );
}
