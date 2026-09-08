import type { INestApplicationContext } from "@nestjs/common";

/** Close the context and rethrow, preserving both errors if cleanup also fails. */
export async function closeFailedApplication(
  application: Pick<INestApplicationContext, "close">,
  error: unknown,
): Promise<never> {
  try {
    await application.close();
  } catch (closeError) {
    throw new AggregateError(
      [error, closeError],
      "Application startup failed and cleanup also failed",
    );
  }
  throw error;
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
