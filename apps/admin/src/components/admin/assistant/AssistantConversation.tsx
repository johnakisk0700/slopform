import { Button } from "@heroui/react";
import {
  MessageSquarePlus,
  PencilLine,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import type {
  AssistantDisplayMessage,
  AssistantTurnStatus,
} from "../../../features/assistant/schema";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantThinkingIndicator } from "./AssistantThinkingIndicator";

interface AssistantConversationProps {
  messages: readonly AssistantDisplayMessage[];
  phase: "loading" | "submitting" | AssistantTurnStatus | "idle";
  failureMessage: string | null;
  canRetryFailure: boolean;
  retryLabel: string;
  startNewLabel: string;
  announcement: string;
  onRetryFailure: () => void;
  onReviseFailure: (() => void) | null;
  onStartNew: () => void;
  onStarter: (prompt: string) => void;
}

const STARTERS = [
  "Draft a concise operator briefing for the next dinner.",
  "Turn these notes into decisions, owners, blockers and next steps:\n\n",
  "Stress-test this event plan and prioritise the risks:\n\n",
] as const;

/** Message list skeleton copied from notes_ai's narrow written-page chat. */
export function AssistantConversation({
  messages,
  phase,
  failureMessage,
  canRetryFailure,
  retryLabel,
  startNewLabel,
  announcement,
  onRetryFailure,
  onReviseFailure,
  onStartNew,
  onStarter,
}: AssistantConversationProps) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const busy =
    phase === "submitting" || phase === "queued" || phase === "running";
  const waitingForAssistant = busy && messages.at(-1)?.role !== "assistant";

  return (
    /* The source drops the column's left padding once there is room, so the
       written page starts on the composer's own line of writing rather than
       inset from it. */
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-3 pb-40 lg:pl-0">
      <header className="mb-3 flex h-14 w-full items-center justify-between border-b border-border-subtle">
        <span className="hidden text-xs text-ink-muted sm:inline">
          Ask the assistant about operations, events and decisions.
        </span>
        <time className="ml-auto shrink-0 text-xs tabular-nums text-ink-subtle">
          {today}
        </time>
      </header>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <div
        role="log"
        aria-label="Assistant conversation"
        aria-busy={busy}
        className="grid gap-3"
      >
        {messages.map((message, index) => (
          <AssistantMessage
            key={message.id}
            message={message}
            reserveAnswerHeight={
              busy &&
              index === messages.length - 1 &&
              message.role === "assistant"
            }
          />
        ))}

        {waitingForAssistant ? (
          <div className="min-h-[clamp(18rem,48dvh,30rem)] max-w-none">
            <AssistantThinkingIndicator />
          </div>
        ) : null}

        {failureMessage ? (
          <div
            role="alert"
            className="mt-1 flex items-start gap-3 rounded-md border border-danger/35 bg-danger-soft px-3 py-2.5 text-sm"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-danger"
            />
            <div className="grid gap-2">
              <p className="text-ink">{failureMessage}</p>
              <div className="flex flex-wrap gap-1.5">
                {canRetryFailure ? (
                  <Button size="sm" variant="ghost" onPress={onRetryFailure}>
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    {retryLabel}
                  </Button>
                ) : null}
                {onReviseFailure ? (
                  <Button size="sm" variant="ghost" onPress={onReviseFailure}>
                    <PencilLine aria-hidden="true" className="size-3.5" />
                    Revise as new request
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onPress={onStartNew}>
                  <MessageSquarePlus aria-hidden="true" className="size-3.5" />
                  {startNewLabel}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {messages.length === 0 && phase === "idle" && !failureMessage ? (
          <div className="grid min-h-[20rem] content-center justify-items-start gap-4 py-8">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-caps text-primary">
                A clear page
              </p>
              <h2 className="mt-1 text-xl font-extrabold text-ink">
                What should we work through?
              </h2>
            </div>
            <div className="grid max-w-xl gap-1">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => onStarter(starter)}
                  className="border-l-2 border-border px-3 py-1.5 text-left text-sm text-ink-muted transition-colors hover:border-primary hover:text-ink"
                >
                  {starter.trim()}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
