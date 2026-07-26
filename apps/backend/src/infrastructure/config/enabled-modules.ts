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

export function isFeedbackSimulatorHttpEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  if (environment.NODE_ENV?.trim() === "production") {
    return false;
  }

  return (
    environment.FEEDBACK_SIMULATOR_ENABLED?.trim().toLowerCase() === "true" &&
    (environment.TRANSPORT_MODE?.trim().toLowerCase() ?? "simulated") ===
      "simulated"
  );
}

export function isWasenderTransportEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    Boolean(environment.WASENDER_SESSION_API_KEY?.trim()) ||
    environment.TRANSPORT_MODE?.trim().toLowerCase() === "wasender"
  );
}
