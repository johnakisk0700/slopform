import { z } from "zod";

import { emptyStringToUndefined } from "./environment-values.js";

export const FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODES = [
  "none",
  "reject",
  "rate-limit",
  "unknown-before-accept",
  "unknown-after-accept",
  "mixed",
] as const;

export const feedbackSimulatedTransportFaultModeEnvironmentSchema =
  z.preprocess(
    emptyStringToUndefined,
    z.enum(FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODES).default("none"),
  );

export const feedbackSimulatedTransportFaultPercentEnvironmentSchema =
  z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().min(0).max(100).default(0),
  );

export const feedbackSimulatedTransportSeedEnvironmentSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
      "Expected a log-safe simulator seed",
    )
    .default("1"),
);

export const feedbackSimulatedTransportMaxDelayEnvironmentSchema = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(0).max(30_000).default(0),
);

export const feedbackSimulatedTransportProfileSchema = z
  .object({
    faultMode: z.enum(FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODES),
    faultPercent: z.number().int().min(0).max(100),
    seed: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    maxDelayMs: z.number().int().min(0).max(30_000),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.faultMode === "none" && profile.faultPercent !== 0) {
      context.addIssue({
        code: "custom",
        message:
          "Fault percent must be 0 when the simulated transport fault mode is none",
        path: ["faultPercent"],
      });
    }
    if (profile.faultMode !== "none" && profile.faultPercent === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Fault percent must be greater than 0 when a simulated transport fault mode is selected",
        path: ["faultPercent"],
      });
    }
  });

export type FeedbackSimulatedTransportProfile = z.infer<
  typeof feedbackSimulatedTransportProfileSchema
>;

/**
 * Resolves the same non-secret simulated transport treatment from validated
 * ConfigService values and the raw environment used by BullMQ worker naming.
 */
export function resolveFeedbackSimulatedTransportProfile(input: {
  readonly faultMode?: unknown;
  readonly faultPercent?: unknown;
  readonly seed?: unknown;
  readonly maxDelayMs?: unknown;
}): FeedbackSimulatedTransportProfile {
  return feedbackSimulatedTransportProfileSchema.parse({
    faultMode: feedbackSimulatedTransportFaultModeEnvironmentSchema.parse(
      input.faultMode,
    ),
    faultPercent: feedbackSimulatedTransportFaultPercentEnvironmentSchema.parse(
      input.faultPercent,
    ),
    seed: feedbackSimulatedTransportSeedEnvironmentSchema.parse(input.seed),
    maxDelayMs: feedbackSimulatedTransportMaxDelayEnvironmentSchema.parse(
      input.maxDelayMs,
    ),
  });
}
