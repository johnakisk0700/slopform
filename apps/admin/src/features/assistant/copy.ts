import type { AssistantDisplayMessage, AssistantToolCall } from "./schema";

export type AssistantCopyMode = "answer" | "answer-with-activity";

/**
 * Builds clipboard text only from the durable fields already rendered for one
 * settled answer. No browser state or current picker value can leak into it.
 */
export function formatAssistantMessageForCopy(
  message: AssistantDisplayMessage,
  mode: AssistantCopyMode,
): string {
  if (mode === "answer") return message.content;

  const sections: string[] = [];
  if (message.reasoning) {
    sections.push(`Thinking\n\n${message.reasoning}`);
  }
  if (message.toolCalls.length > 0) {
    sections.push(
      `Tools\n\n${message.toolCalls.map(formatToolCall).join("\n\n")}`,
    );
  }
  sections.push(`Answer\n\n${message.content}`);
  return sections.join("\n\n---\n\n");
}

function formatToolCall(call: AssistantToolCall): string {
  const details = [`- ${call.label} (${call.tool}) — ${call.state}`];
  if (call.input !== null) {
    details.push(
      `  Input${call.inputTruncated ? " (truncated)" : ""}:\n${indentJson(call.input)}`,
    );
  }
  if (call.output !== null) {
    details.push(
      `  Result${call.outputTruncated ? " (truncated)" : ""}:\n${indentJson(call.output)}`,
    );
  }
  return details.join("\n");
}

function indentJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
