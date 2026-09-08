import { useMutation, useQuery } from "@tanstack/react-query";

import type {
  SimulatorInjectResponse,
  SimulatorThreadResponse,
} from "../features/feedback/simulator";
import { api } from "./api";

/**
 * The dev feedback simulator facade (WP8/U2).
 *
 * This is the single documented exception to calling the backend through the
 * generated client: the simulator controller is mounted only outside
 * production with `TRANSPORT_MODE=simulated`, so it is deliberately excluded
 * from the published OpenAPI document and orval cannot generate hooks for it.
 * Both calls therefore go through the same shared `ofetch` client every
 * generated hook uses. The response types live beside the facade because the
 * dev-only routes are intentionally absent from the published API document.
 *
 * Nothing on the product path may follow this pattern.
 */

const SIMULATOR_BASE = "/v1/dev/feedback/simulator";

function getFeedbackSimulatorThreadQueryKey(phoneE164: string) {
  return [`${SIMULATOR_BASE}/thread`, phoneE164] as const;
}

/**
 * Reads the simulated transport's view of one phone number.
 *
 * It doubles as the availability probe for U2: when the simulator is not
 * mounted the request fails (404) and the composer stays hidden, so the
 * server decides whether the dev affordance exists rather than a client flag
 * that can disagree with the deployment.
 */
export function useFeedbackSimulatorThread(
  phoneE164: string | undefined,
  options?: { refetchInterval?: number | false },
) {
  return useQuery<SimulatorThreadResponse>({
    queryKey: getFeedbackSimulatorThreadQueryKey(phoneE164 ?? ""),
    queryFn: async ({ signal }) => {
      return api<SimulatorThreadResponse>(`${SIMULATOR_BASE}/thread`, {
        method: "GET",
        query: { phoneE164 },
        signal,
      });
    },
    enabled: phoneE164 !== undefined && phoneE164 !== "",
    // A missing simulator is the expected answer in any non-simulated
    // deployment, so this must not retry or shout.
    retry: false,
    staleTime: 0,
    ...(options?.refetchInterval === undefined
      ? {}
      : { refetchInterval: options.refetchInterval }),
  });
}

export interface InjectSimulatorMessageVariables {
  phoneE164: string;
  text: string;
  /** Stable identity for safe retries of one exact simulator draft. */
  idempotencyKey: string;
  /** `true` injects an operator-side outbound with no outbox row (D7). */
  fromMe?: boolean;
}

/** Posts an inbound message as the participant, through the real ingress path. */
export function useInjectFeedbackSimulatorMessage() {
  return useMutation<
    SimulatorInjectResponse,
    Error,
    InjectSimulatorMessageVariables
  >({
    mutationFn: async (variables) => {
      return api<SimulatorInjectResponse>(`${SIMULATOR_BASE}/inject`, {
        method: "POST",
        body: {
          phoneE164: variables.phoneE164,
          text: variables.text,
          fromMe: variables.fromMe ?? false,
          idempotencyKey: variables.idempotencyKey,
        },
      });
    },
  });
}
