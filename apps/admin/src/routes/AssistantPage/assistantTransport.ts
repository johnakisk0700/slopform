import {
  consumeAssistantEventStream,
  type AssistantStreamFrame,
} from "../../features/assistant/stream";
import { api } from "../../lib/api";

export const ASSISTANT_THREADS_PATH = "/v1/assistant/threads";

const POLL_INTERVAL_MS = 1_200;

export function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timeoutId = 0;

    const finish = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    timeoutId = window.setTimeout(finish, POLL_INTERVAL_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function turnPath(threadId: string, turnId: string): string {
  return `${ASSISTANT_THREADS_PATH}/${threadId}/turns/${turnId}`;
}

export async function watchAssistantStream(
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  onFrame: (frame: AssistantStreamFrame) => void,
): Promise<boolean> {
  const response = await api.raw<never, "stream">(
    `${turnPath(threadId, turnId)}/stream`,
    {
      headers: { Accept: "text/event-stream" },
      responseType: "stream",
      // The ordinary client timeout protects finite requests. This response is
      // intentionally open for the provider's full two-minute generation bound.
      timeout: 0,
      signal,
    },
  );
  const stream = response._data ?? response.body;
  if (!stream) return false;

  let completed = false;
  await consumeAssistantEventStream(stream, (frame) => {
    if (frame.kind === "done") completed = true;
    onFrame(frame);
  });
  return completed;
}
