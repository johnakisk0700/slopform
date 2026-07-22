const READINESS_TIMEOUT_MILLISECONDS = 1_000;

export async function withReadinessTimeout(
  operation: Promise<void>,
  dependency: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `${dependency} readiness timed out after ${READINESS_TIMEOUT_MILLISECONDS}ms`,
            ),
          );
        }, READINESS_TIMEOUT_MILLISECONDS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
