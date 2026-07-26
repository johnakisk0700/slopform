import { z } from "zod";

/**
 * Response shapes for the two dev-only simulator endpoints
 * (`POST /v1/dev/feedback/simulator/inject`, `GET .../thread`).
 *
 * These are the one documented exception to "never hand-write a response
 * schema": the simulator controller is mounted only when
 * `FEEDBACK_SIMULATOR_ENABLED` is true, `TRANSPORT_MODE` is `simulated` and
 * `NODE_ENV` is not production, so it is intentionally absent from the
 * published OpenAPI document and the generated client cannot describe it.
 * Every product endpoint on this screen goes through the generated hooks.
 *
 * Mirrors `apps/backend/src/modules/post-event-feedback/simulator/simulator.schemas.ts`.
 */

const simulatorPhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

export const simulatorInjectResponseSchema = z.object({
  ingressId: z.uuid(),
  inserted: z.boolean(),
});

export type SimulatorInjectResponse = z.infer<
  typeof simulatorInjectResponseSchema
>;

const simulatorThreadMessageSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.enum(["ingress", "sim_outbound"]),
  direction: z.enum(["inbound", "outbound"]),
  text: z.string().min(1),
  occurredAt: z.iso.datetime(),
  ingressId: z.uuid().optional(),
  outboxId: z.uuid().optional(),
});

export const simulatorThreadResponseSchema = z.object({
  phoneE164: simulatorPhoneSchema,
  messages: z.array(simulatorThreadMessageSchema),
});

export type SimulatorThreadResponse = z.infer<
  typeof simulatorThreadResponseSchema
>;

/** Longest inbound text the backend will accept from the injector. */
export const SIMULATOR_MESSAGE_MAX_LENGTH = 4096;
