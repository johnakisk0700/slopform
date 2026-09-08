/**
 * Response types for the two dev-only simulator endpoints
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
export interface SimulatorInjectResponse {
  ingressId: string;
  inserted: boolean;
}

interface SimulatorThreadMessage {
  id: string;
  source: "ingress" | "sim_outbound";
  direction: "inbound" | "outbound";
  text: string;
  occurredAt: string;
  ingressId?: string;
  outboxId?: string;
}

export interface SimulatorThreadResponse {
  phoneE164: string;
  messages: SimulatorThreadMessage[];
}

/** Longest inbound text the backend will accept from the injector. */
export const SIMULATOR_MESSAGE_MAX_LENGTH = 4096;
