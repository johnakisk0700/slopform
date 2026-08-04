import { createHash } from "node:crypto";

import type { FeedbackSimulatedTransportProfile } from "../../../infrastructure/config/feedback-simulated-transport.js";

export type FeedbackSimulatedTransportDecision = {
  readonly outcome:
    | "accepted"
    | "rejected"
    | "rate-limited"
    | "unknown-before-accept"
    | "unknown-after-accept";
  readonly delayMs: number;
};

const MIXED_FAULTS = [
  "rejected",
  "rate-limited",
  "unknown-before-accept",
  "unknown-after-accept",
] as const;

/**
 * Selects one stable provider outcome from non-secret configuration and the
 * durable outbox id. Replicas with one identical profile cannot disagree merely
 * because they claimed the row in a different order; changing the profile is
 * an operational treatment change, not part of this pure decision.
 */
export function decideFeedbackSimulatedTransport(
  profile: FeedbackSimulatedTransportProfile,
  outboxId: string,
): FeedbackSimulatedTransportDecision {
  const delayMs =
    profile.maxDelayMs === 0
      ? 0
      : Math.floor(
          deterministicUnit(profile.seed, outboxId, "delay") *
            (profile.maxDelayMs + 1),
        );
  const faultSelected =
    profile.faultMode !== "none" &&
    deterministicUnit(profile.seed, outboxId, "fault") <
      profile.faultPercent / 100;

  if (!faultSelected) {
    return { outcome: "accepted", delayMs };
  }

  if (profile.faultMode === "mixed") {
    const index = Math.min(
      MIXED_FAULTS.length - 1,
      Math.floor(
        deterministicUnit(profile.seed, outboxId, "mixed-kind") *
          MIXED_FAULTS.length,
      ),
    );
    return { outcome: MIXED_FAULTS[index] ?? "rejected", delayMs };
  }

  if (profile.faultMode === "reject") {
    return { outcome: "rejected", delayMs };
  }
  if (profile.faultMode === "rate-limit") {
    return { outcome: "rate-limited", delayMs };
  }
  if (
    profile.faultMode === "unknown-before-accept" ||
    profile.faultMode === "unknown-after-accept"
  ) {
    return { outcome: profile.faultMode, delayMs };
  }

  // `none` cannot select a fault and `mixed` returned above. Keep the fallback
  // accepted if an impossible profile slips past a future contract change.
  return { outcome: "accepted", delayMs };
}

function deterministicUnit(
  seed: string,
  outboxId: string,
  salt: string,
): number {
  const digest = createHash("sha256")
    .update(seed)
    .update("\0")
    .update(outboxId)
    .update("\0")
    .update(salt)
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}
