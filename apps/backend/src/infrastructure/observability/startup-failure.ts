export interface StartupFailureReporting {
  readonly capture: (error: unknown) => void;
  readonly closeApplication?: () => Promise<void>;
  readonly event: "http.bootstrap.failed" | "worker.bootstrap.failed";
  readonly shutdownTelemetry: () => Promise<void>;
  readonly writeFatalEvent: (event: string, error: unknown) => void;
}

export async function handleStartupFailure(
  error: unknown,
  handlers: StartupFailureReporting,
): Promise<void> {
  try {
    handlers.capture(error);
  } catch (captureError) {
    handlers.writeFatalEvent("telemetry.capture.failed", captureError);
  }

  let reportedError = error;

  if (handlers.closeApplication) {
    try {
      await handlers.closeApplication();
    } catch (closeError) {
      reportedError = new AggregateError(
        [error, closeError],
        "Application startup failed and cleanup also failed",
      );
    }
  }

  handlers.writeFatalEvent(handlers.event, reportedError);

  try {
    await handlers.shutdownTelemetry();
  } catch (shutdownError) {
    handlers.writeFatalEvent("telemetry.shutdown.failed", shutdownError);
  }
}

function redactUrlSecrets(value: string): string {
  return value
    .replace(
      /((?:https?|postgres(?:ql)?|redis(?:s)?|mongodb(?:\+srv)?):\/\/)[^@\s/]+@/giu,
      "$1[Redacted]@",
    )
    .replace(/([?&][^=&#\s]+)=[^&#\s]*/gu, "$1=[Redacted]");
}

export function serializeStartupError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: redactUrlSecrets(error.message),
      name: error.name,
      ...(error.stack ? { stack: redactUrlSecrets(error.stack) } : {}),
      ...(error instanceof AggregateError
        ? { errors: error.errors.map(serializeStartupError) }
        : {}),
    };
  }

  return { message: redactUrlSecrets(String(error)) };
}

export function writeStructuredFatalEvent(event: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      time: new Date().toISOString(),
      event,
      error: serializeStartupError(error),
    })}\n`,
  );
}
