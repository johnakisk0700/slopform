import { Button } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import {
  ASSISTANT_MODELS,
  type AssistantDisplayMessage,
} from "../../../features/assistant/schema";
import { formatEstimatedAssistantCost } from "../../../features/assistant/cost";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantReasoningCard } from "./AssistantReasoningCard";
import { AssistantThinkingIndicator } from "./AssistantThinkingIndicator";
import { AssistantToolCallCard } from "./AssistantToolCallCard";

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
  ({
    message,
    minHeight,
  }: {
    message: AssistantDisplayMessage;
    minHeight?: number;
  }) => {
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

    // Text from a turn still in flight is streamed, not an answer: keep the
    // activity marker and withhold the copy/attribution footer until the durable
    // result lands, so nothing invites acting on a half-written reply.
    const streaming =
      message.status === "queued" || message.status === "running";

    return (
      <article
        id={message.id}
        aria-label="Assistant message"
        style={minHeight === undefined ? undefined : { minHeight }}
      >
        {message.toolCalls.length > 0 ? (
          <div>
            {message.toolCalls.map((call) => (
              <AssistantToolCallCard key={call.toolCallId} call={call} />
            ))}
          </div>
        ) : null}
        {message.reasoning ? (
          <AssistantReasoningCard
            reasoning={message.reasoning}
            streaming={streaming}
          />
        ) : null}
        {message.content ? (
          <div className="assistant-markdown max-w-none">
            <AssistantMarkdown>{message.content}</AssistantMarkdown>
          </div>
        ) : null}
        {streaming ? (
          <AssistantThinkingIndicator />
        ) : message.status === "succeeded" ? (
          <AssistantMessageActions
            content={message.content}
            model={modelLabel(message)}
            effort={message.effort}
            serviceTier={message.serviceTier}
            usage={message.usage}
          />
        ) : null}
      </article>
    );
  },
  (previous, next) =>
    previous.message.id === next.message.id &&
    previous.message.role === next.message.role &&
    previous.message.content === next.message.content &&
    previous.message.model === next.message.model &&
    previous.message.effort === next.message.effort &&
    previous.message.serviceTier === next.message.serviceTier &&
    previous.message.reasoning === next.message.reasoning &&
    previous.message.toolCalls === next.message.toolCalls &&
    previous.message.usage === next.message.usage &&
    previous.message.status === next.message.status &&
    previous.minHeight === next.minHeight,
);

AssistantMessage.displayName = "AssistantMessage";

function AssistantMessageActions({
  content,
  model,
  effort,
  serviceTier,
  usage,
}: {
  content: string;
  model: string;
  effort: AssistantDisplayMessage["effort"];
  serviceTier: AssistantDisplayMessage["serviceTier"];
  usage: AssistantDisplayMessage["usage"];
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
    <div className="mt-1.5 flex items-center gap-0.5 text-ink-muted">
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
      <span className="ml-1.5 font-mono text-[length:var(--jts-text-2xs)] tabular-nums text-ink-subtle">
        {model} · {effort} thinking
        {/* Stamped only when the fast lane was actually bought, because it is
            the one setting here that changed what the turn cost. */}
        {serviceTier === "fast" ? " · fast lane" : ""}
        {usage?.estimatedCostEurMicros != null
          ? ` · est. ${formatEstimatedAssistantCost(usage.estimatedCostEurMicros)}`
          : ""}
        {usage?.totalTokens != null
          ? ` · ${usage.totalTokens.toLocaleString("en-GB")} tokens`
          : ""}
      </span>
    </div>
  );
}
