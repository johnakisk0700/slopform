import type { Environment } from "./environment.js";

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
  return isFeedbackSimulatorEnabled({
    nodeEnv: environment.NODE_ENV?.trim().toLowerCase(),
    productionRehearsalEnabled:
      environment.FEEDBACK_PRODUCTION_REHEARSAL_ENABLED?.trim().toLowerCase() ===
      "true",
    simulatorEnabled:
      environment.FEEDBACK_SIMULATOR_ENABLED?.trim().toLowerCase() === "true",
    transportMode:
      environment.TRANSPORT_MODE?.trim().toLowerCase() ?? "simulated",
  });
}

export function isFeedbackSimulatorEnabled(environment: {
  readonly nodeEnv: Environment["NODE_ENV"] | string | undefined;
  readonly productionRehearsalEnabled: boolean;
  readonly simulatorEnabled: boolean;
  readonly transportMode: Environment["TRANSPORT_MODE"] | string;
}): boolean {
  return (
    environment.simulatorEnabled &&
    environment.transportMode === "simulated" &&
    (environment.nodeEnv !== "production" ||
      environment.productionRehearsalEnabled)
  );
}

export function isWasenderTransportEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.TRANSPORT_MODE?.trim().toLowerCase() === "wasender";
}
