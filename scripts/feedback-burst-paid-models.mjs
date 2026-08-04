/**
 * Paid treatments the burst runner is allowed to select.
 *
 * `prova` is deliberately a named, exact profile rather than a model allowlist:
 * changing an effort or inheriting an account service tier makes it a different
 * experiment. Qwen is not another spelling of prova; it is reachable only via
 * the explicit comparison CLI path.
 */
const PROVA_CONTROLS = Object.freeze({
  reasoningEffort: "medium",
  replyReasoningEffort: "medium",
  attentionReasoningEffort: "medium",
  serviceTier: null,
});

export const FEEDBACK_BURST_PROFILES = Object.freeze({
  prova: Object.freeze({
    name: "prova",
    mode: "profile",
    model: "openai/gpt-5.6-luna",
    provider: "openai",
    providerModelId: "gpt-5.6-luna",
    controls: PROVA_CONTROLS,
  }),
});

export const FEEDBACK_BURST_COMPARISONS = Object.freeze({
  qwen: Object.freeze({
    name: "qwen-comparison",
    mode: "comparison",
    model: "qwen/qwen3.7-max",
    provider: "openrouter",
    providerModelId: "qwen/qwen3.7-max",
    // Keep the reasoning treatment equal to the Luna prova. The provider route is the
    // comparison variable; OpenRouter has no OpenAI service-tier control.
    controls: PROVA_CONTROLS,
  }),
});

export const FEEDBACK_BURST_PAID_MODELS = Object.freeze([
  FEEDBACK_BURST_PROFILES.prova.model,
  FEEDBACK_BURST_COMPARISONS.qwen.model,
]);

export const FEEDBACK_BURST_QUESTION_SET_VERSION = 2;

export function resolveFeedbackBurstTreatment(args) {
  if (args.model !== undefined) {
    throw new Error(
      "--model is not a reproducible burst treatment; use --profile prova or --comparison qwen",
    );
  }
  if (args.profile !== undefined && args.comparison !== undefined) {
    throw new Error("--profile and --comparison are mutually exclusive");
  }
  if (args.profile !== undefined) {
    const profile = FEEDBACK_BURST_PROFILES[String(args.profile)];
    if (!profile) {
      throw new Error(
        `Unknown burst profile "${String(args.profile)}". Available: ${Object.keys(FEEDBACK_BURST_PROFILES).join(", ")}`,
      );
    }
    return profile;
  }
  if (args.comparison !== undefined) {
    const comparison = FEEDBACK_BURST_COMPARISONS[String(args.comparison)];
    if (!comparison) {
      throw new Error(
        `Unknown burst comparison "${String(args.comparison)}". Available: ${Object.keys(FEEDBACK_BURST_COMPARISONS).join(", ")}`,
      );
    }
    return comparison;
  }
  return null;
}

/**
 * Live guests spend through a separate local model client. They therefore need
 * a separate enable switch and confirmation from the provider-backed extraction
 * treatment. Stub mode without either flag deterministically substitutes
 * silence for those six unscripted people and performs no persona-model call.
 */
export function resolveFeedbackBurstLiveGuests(args) {
  const enabled = args["live-guests"] === true;
  const confirmed = args["confirm-live-guests"] === true;
  if (confirmed && !enabled) {
    throw new Error(
      "--confirm-live-guests has no effect without --live-guests",
    );
  }
  if (enabled && !confirmed) {
    throw new Error(
      "Live persona-model calls are not confirmed; add --confirm-live-guests",
    );
  }
  return enabled;
}

/**
 * Seed-only prepares the ordinary intro-only campaign baseline and then stops.
 * It cannot include improvised guests because no participant turn is driven in
 * this mode; accepting both switches would make the run label a lie.
 */
export function resolveFeedbackBurstSeedOnly(args, liveGuestsEnabled) {
  const enabled = args["seed-only"] === true;
  if (enabled && liveGuestsEnabled) {
    throw new Error("--seed-only cannot be combined with --live-guests");
  }
  return enabled;
}

export function assertFeedbackBurstLiveGuestTreatment(
  liveGuestsEnabled,
  treatment,
) {
  if (liveGuestsEnabled && treatment === null) {
    throw new Error(
      "Live guests require --profile prova or --comparison qwen; the deterministic stub cannot interpret improvised participant messages",
    );
  }
}

export function assertFeedbackBurstLiveGuestCallAllowed(confirmed) {
  if (confirmed !== true) {
    throw new Error(
      "Refusing cursor-agent persona call without separately confirmed live guests",
    );
  }
}

export function assertFeedbackBurstTreatmentAdapter(treatment, adapter) {
  if (
    adapter?.provider !== treatment.provider ||
    adapter?.providerModelId !== treatment.providerModelId
  ) {
    throw new Error(
      `Burst treatment ${treatment.name} requires ${treatment.provider}/${treatment.providerModelId}, but the built adapter resolved ${String(adapter?.provider)}/${String(adapter?.providerModelId)}`,
    );
  }
}

export function assertFeedbackBurstQuestionSetVersion(campaign, context) {
  if (
    !campaign ||
    campaign.questionSetVersion !== FEEDBACK_BURST_QUESTION_SET_VERSION
  ) {
    throw new Error(
      `${context} must use feedback question-set V${FEEDBACK_BURST_QUESTION_SET_VERSION}; received ${String(campaign?.questionSetVersion ?? "missing")}`,
    );
  }
  return campaign;
}
