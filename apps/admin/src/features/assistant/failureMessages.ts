export function responseStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return null;
  }

  const { response } = error;
  if (
    typeof response !== "object" ||
    response === null ||
    !("status" in response) ||
    typeof response.status !== "number"
  ) {
    return null;
  }

  return response.status;
}

export function requestFailureMessage(status: number | null): string {
  switch (status) {
    case 401:
    case 403:
      return "Your session cannot access the assistant. Sign in again, then try once more.";
    case 404:
      return "This conversation is no longer available. Open another conversation or start a new one.";
    case 409:
      return "Another turn is already active in this conversation. Reload it to resume the durable turn.";
    case 503:
      return "The assistant service or selected model is unavailable. Ask an administrator to check the AI credentials.";
    default:
      return "The assistant service could not be reached or returned an invalid response. The same request can be retried safely.";
  }
}
