const POST_EVENT_FEEDBACK_STOP_COMMANDS = [
  "stop",
  "stop all",
  "unsubscribe",
  "διακοπη",
  "στοπ",
] as const;

export function foldGreekAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

export function normalizePostEventFeedbackStopInput(text: string): string {
  return foldGreekAccents(text).toLowerCase().trim().replace(/\s+/g, " ");
}

export function matchesPostEventFeedbackStopCommand(text: string): boolean {
  const normalized = normalizePostEventFeedbackStopInput(text);
  return (POST_EVENT_FEEDBACK_STOP_COMMANDS as readonly string[]).includes(
    normalized,
  );
}
