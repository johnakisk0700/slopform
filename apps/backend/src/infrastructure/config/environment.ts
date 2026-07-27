import { z } from "zod";

import { emptyStringToUndefined, parseUrl } from "./environment-values.js";
import {
  addProductionMongoIssues,
  parseMongoConnectionString,
} from "./mongo-connection-string.js";
import { observabilityEnvironmentSchema } from "./observability-environment.js";

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
    // D12: the extraction model is configurable. Infrastructure does not import
    // product modules, so the registry membership check belongs to the feedback
    // module itself, which rejects an unknown id at worker start rather than
    // reaching some other provider.
    FEEDBACK_EXTRACTION_MODEL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().min(1).max(200).optional(),
    ),
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
    /**
     * Dev/staging HTTP injector and sim-thread read API (WP8). Requires
     * `TRANSPORT_MODE=simulated` and a non-production `NODE_ENV`.
     */
    FEEDBACK_SIMULATOR_ENABLED: booleanFromEnvironment,
    /**
     * Rehearsal-only: replace the real extraction model with the deterministic
     * burst stub. Requires `FEEDBACK_SIMULATOR_ENABLED` and a non-production
     * `NODE_ENV` — a scripted model outside the simulator is a silent lie
     * about what the system is running.
     */
    FEEDBACK_EXTRACTION_STUB: booleanFromEnvironment,
    /**
     * D11/D-b: hours of participant silence between nudges.
     *
     * It is the rung spacing of a ladder, not a one-off delay: nudge N is due
     * after N × this many hours without a participant message, so the default
     * 24 sends at 24h and again at 48h. Silence is measured from what the
     * participant last said, so answering resets it and somebody who answered
     * two of four questions is nudged like anyone else — they used to be
     * excluded from reminders entirely for having replied once.
     */
    FEEDBACK_REMINDER_AFTER_HOURS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(168).default(24),
    ),
    /**
     * D11: hours of participant silence before an open conversation expires.
     *
     * Silence, not age: somebody who finally answered at hour 71 is mid
     * conversation, and closing them an hour later threw away the rest of what
     * they had to say.
     */
    FEEDBACK_EXPIRE_AFTER_HOURS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(336).default(72),
    ),
    /**
     * D-b: how many nudges one conversation may receive in total.
     *
     * Two, plus the intro, is three WhatsApp messages to somebody who never
     * replies — the ceiling before outreach starts reading as spam.
     */
    FEEDBACK_MAX_REMINDERS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(0).max(5).default(2),
    ),
    /**
     * Minutes a `provider_message_ingress` row may stay `pending` before the
     * recovery sweep re-enqueues `feedback.materialize.v1`.
     */
    FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(1440).default(5),
    ),
    /**
     * Delivery channel for the operator alert raised when a conversation first
     * needs attention (model safety signal or permanently failed extraction).
     * `log` emits a structured `feedback.operator_alert` line; `off` disables
     * notification while `needsAttention` still records the state durably.
     *
     * The named extension point is a future WhatsApp adapter — it stays out of
     * scope until it has an operator-number configuration, a rate limit and a
     * privacy review.
     */
    FEEDBACK_OPERATOR_ALERT_MODE: z.preprocess(
      emptyStringToUndefined,
      z.enum(["log", "off"]).default("log"),
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

    if (environment.NODE_ENV === "production") {
      if (environment.TRANSPORT_MODE === "simulated") {
        context.addIssue({
          code: "custom",
          message:
            "TRANSPORT_MODE=simulated is not allowed in production; use wasender",
          path: ["TRANSPORT_MODE"],
        });
      }
      if (environment.FEEDBACK_SIMULATOR_ENABLED) {
        context.addIssue({
          code: "custom",
          message: "FEEDBACK_SIMULATOR_ENABLED cannot be enabled in production",
          path: ["FEEDBACK_SIMULATOR_ENABLED"],
        });
      }
      if (environment.FEEDBACK_EXTRACTION_STUB) {
        context.addIssue({
          code: "custom",
          message: "FEEDBACK_EXTRACTION_STUB cannot be enabled in production",
          path: ["FEEDBACK_EXTRACTION_STUB"],
        });
      }
    }

    if (
      environment.FEEDBACK_SIMULATOR_ENABLED &&
      environment.TRANSPORT_MODE !== "simulated"
    ) {
      context.addIssue({
        code: "custom",
        message: "FEEDBACK_SIMULATOR_ENABLED requires TRANSPORT_MODE=simulated",
        path: ["FEEDBACK_SIMULATOR_ENABLED"],
      });
    }

    if (
      environment.FEEDBACK_EXTRACTION_STUB &&
      !environment.FEEDBACK_SIMULATOR_ENABLED
    ) {
      context.addIssue({
        code: "custom",
        message:
          "FEEDBACK_EXTRACTION_STUB requires FEEDBACK_SIMULATOR_ENABLED=true",
        path: ["FEEDBACK_EXTRACTION_STUB"],
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
      addProductionMongoIssues(mongo, context);
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  return environmentSchema.parse(input);
}
