import { readFileSync } from "node:fs";

/**
 * Build the admin headers used by the burst runner.
 *
 * Clerk frontend session tokens are deliberately short-lived. A token file is
 * therefore read lazily for every request, allowing an authenticated browser
 * session to refresh it atomically while a long production rehearsal runs.
 */
export function createFeedbackBurstHeaders({
  token,
  tokenFile,
  correlationId,
}) {
  if (token && tokenFile) {
    throw new Error(
      "Use either --token/CLERK_BEARER_TOKEN or --token-file/CLERK_BEARER_TOKEN_FILE, not both",
    );
  }

  const headers = {
    "content-type": "application/json",
    "x-request-id": correlationId,
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
    return headers;
  }

  if (tokenFile) {
    const readAuthorization = () => {
      const currentToken = readFileSync(tokenFile, "utf8").trim();
      if (!currentToken) {
        throw new Error(`Bearer token file is empty: ${tokenFile}`);
      }
      return `Bearer ${currentToken}`;
    };

    // Validate before the runner makes its first request. The getter remains
    // enumerable so fetch/Headers and per-request object spreads read the latest
    // token rather than capturing the first one for the whole rehearsal.
    readAuthorization();
    Object.defineProperty(headers, "authorization", {
      enumerable: true,
      configurable: false,
      get: readAuthorization,
    });
  }

  return headers;
}
