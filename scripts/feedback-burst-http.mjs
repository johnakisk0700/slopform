import { createHash } from "node:crypto";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;

export function createFeedbackBurstIdempotencyKey({
  correlationId,
  personaId,
  messageIndex,
}) {
  const digest = createHash("sha256")
    .update(`${correlationId}\0${personaId}\0${messageIndex}`)
    .digest("hex");
  return `burst-${digest}`;
}

/**
 * Fetch JSON with explicit, bounded transient retries.
 *
 * Callers must opt in. Retrying a mutation is safe only when its request body
 * carries an application-level idempotency key.
 */
export async function requestFeedbackBurstJson(
  url,
  init,
  { transientRetries = 0, fetchImpl = fetch, sleepImpl = sleep } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (attempt < transientRetries) {
        await sleepImpl(retryDelayMs(attempt));
        continue;
      }
      throw new Error(
        `${url}: ${error instanceof Error ? error.message : String(error)} after ${attempt + 1} attempt(s)`,
        { cause: error },
      );
    }

    const payload = await response.json().catch(() => undefined);
    if (response.ok) {
      return payload;
    }

    if (
      attempt < transientRetries &&
      TRANSIENT_HTTP_STATUSES.has(response.status)
    ) {
      await sleepImpl(
        retryDelayMs(attempt, response.headers.get("retry-after")),
      );
      continue;
    }

    const message =
      payload && typeof payload.message === "string"
        ? payload.message
        : Array.isArray(payload?.message)
          ? payload.message.join("; ")
          : `${response.status} ${response.statusText}`;
    throw new Error(`${url}: ${message}`);
  }
}

function retryDelayMs(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** attempt);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
