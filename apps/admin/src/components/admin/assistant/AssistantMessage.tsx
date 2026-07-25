import { Button } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import {
  ASSISTANT_MODELS,
  type AssistantDisplayMessage,
} from "../../../features/assistant/schema";
import { AssistantMarkdown } from "./AssistantMarkdown";

function modelLabel(message: AssistantDisplayMessage): string {
  return (
    ASSISTANT_MODELS.find((model) => model.id === message.model)?.label ??
    message.model
  );
}

/**
 * Port of notes_ai's memoized message split: user turns are compact ink-wash
 * bubbles; assistant turns are full-width written pages with rich Markdown.
 */
export const AssistantMessage = memo(
  ({ message }: { message: AssistantDisplayMessage }) => {
    if (message.role === "user") {
      return (
        <article
          id={message.id}
          aria-label="Your message"
          className="group flex w-full flex-col items-end gap-1.5"
        >
          <div
            data-assistant-user-content
            className="w-fit max-w-[85%] whitespace-pre-wrap rounded-md border border-primary-border bg-primary-soft px-3 py-1.5 text-left text-sm font-medium leading-5 text-ink"
          >
            {message.content}
          </div>
        </article>
      );
    }

    return (
      <article id={message.id} aria-label="Assistant message">
        <div className="assistant-markdown max-w-none">
          <AssistantMarkdown>{message.content}</AssistantMarkdown>
        </div>
        <AssistantMessageActions
          content={message.content}
          model={modelLabel(message)}
          effort={message.effort}
        />
      </article>
    );
  },
  (previous, next) =>
    previous.message.id === next.message.id &&
    previous.message.role === next.message.role &&
    previous.message.content === next.message.content &&
    previous.message.model === next.message.model &&
    previous.message.effort === next.message.effort &&
    previous.message.status === next.message.status,
);

AssistantMessage.displayName = "AssistantMessage";

function AssistantMessageActions({
  content,
  model,
  effort,
}: {
  content: string;
  model: string;
  effort: AssistantDisplayMessage["effort"];
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  async function copyContent(): Promise<void> {
    clearTimeout(resetTimerRef.current);
    try {
      await navigator.clipboard?.writeText(content);
      setCopied(true);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1_000);
    } catch {
      // Clipboard can be unavailable on insecure LAN origins; leave the UI calm.
    }
  }

  return (
    <div className="mt-1.5 flex items-center gap-1 text-ink-muted">
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={copied ? "Response copied" : "Copy response"}
        className="size-7 min-w-7"
        onPress={() => void copyContent()}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-primary" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </Button>
      <span className="ml-1 text-[0.625rem] tabular-nums text-ink-subtle">
        {model} · {effort} thinking
      </span>
    </div>
  );
}
