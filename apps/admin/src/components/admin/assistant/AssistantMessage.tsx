import { Button, Dropdown } from "@heroui/react";
import { Check, Copy, GitFork, PencilLine, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import {
  formatAssistantMessageForCopy,
  type AssistantCopyMode,
} from "../../../features/assistant/copy";
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
    isBranchDisabled,
    onBranchMessage,
  }: {
    message: AssistantDisplayMessage;
    minHeight?: number;
    isBranchDisabled: boolean;
    onBranchMessage: (
      message: AssistantDisplayMessage,
      content: string,
    ) => void;
  }) => {
    if (message.role === "user") {
      return (
        <AssistantUserMessage
          message={message}
          isBranchDisabled={isBranchDisabled}
          onBranchMessage={onBranchMessage}
        />
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
            message={message}
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
    previous.isBranchDisabled === next.isBranchDisabled &&
    previous.onBranchMessage === next.onBranchMessage &&
    previous.minHeight === next.minHeight,
);

AssistantMessage.displayName = "AssistantMessage";

function AssistantUserMessage({
  message,
  isBranchDisabled,
  onBranchMessage,
}: {
  message: AssistantDisplayMessage;
  isBranchDisabled: boolean;
  onBranchMessage: (message: AssistantDisplayMessage, content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const trimmedDraft = draft.trim();

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <article id={message.id} aria-label="Edit your message into a new chat">
        <form
          className="ml-auto grid w-full max-w-xl gap-2 rounded-md border border-border bg-surface-raised p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmedDraft || isBranchDisabled) return;
            onBranchMessage(message, trimmedDraft);
            setEditing(false);
          }}
        >
          <label
            htmlFor={`${message.id}-branch-content`}
            className="text-xs font-semibold text-ink-muted"
          >
            Edit into a new conversation
          </label>
          <textarea
            ref={editorRef}
            id={`${message.id}-branch-content`}
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="min-h-20 w-full resize-y rounded-sm border border-border bg-surface px-2.5 py-2 text-sm leading-5 text-ink"
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onPress={() => {
                setDraft(message.content);
                setEditing(false);
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              isDisabled={!trimmedDraft || isBranchDisabled}
            >
              <GitFork aria-hidden="true" className="size-3.5" />
              Continue in new chat
            </Button>
          </div>
        </form>
      </article>
    );
  }

  return (
    <article
      id={message.id}
      aria-label="Your message"
      className="group flex w-full flex-col items-end gap-1.5"
    >
      <div className="flex w-fit max-w-[85%] items-start gap-1">
        <div className="opacity-60 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            isDisabled={isBranchDisabled}
            aria-label="Edit into a new conversation"
            className="size-7 min-w-7"
            onPress={() => setEditing(true)}
          >
            <PencilLine aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
        <div
          data-assistant-user-content
          className="whitespace-pre-wrap rounded-md border border-primary-border bg-primary-soft px-3 py-1.5 text-left text-sm font-medium leading-5 text-ink"
        >
          {message.content}
        </div>
      </div>
    </article>
  );
}

function AssistantMessageActions({
  message,
  model,
  effort,
  serviceTier,
  usage,
}: {
  message: AssistantDisplayMessage;
  model: string;
  effort: AssistantDisplayMessage["effort"];
  serviceTier: AssistantDisplayMessage["serviceTier"];
  usage: AssistantDisplayMessage["usage"];
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  const hasActivity =
    message.reasoning !== null || message.toolCalls.length > 0;

  async function copyContent(mode: AssistantCopyMode): Promise<void> {
    clearTimeout(resetTimerRef.current);
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(
        formatAssistantMessageForCopy(message, mode),
      );
      setCopied(true);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1_000);
    } catch {
      // Clipboard can be unavailable on insecure LAN origins; leave the UI calm.
    }
  }

  return (
    <div className="mt-1.5 flex items-center gap-0.5 text-ink-muted">
      {hasActivity ? (
        <Dropdown>
          <Dropdown.Trigger
            aria-label={copied ? "Response copied" : "Choose what to copy"}
            className="inline-flex size-7 items-center justify-start rounded-md text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-3.5 text-primary" />
            ) : (
              <Copy aria-hidden="true" className="size-3.5" />
            )}
          </Dropdown.Trigger>
          <Dropdown.Popover placement="top start">
            <Dropdown.Menu
              aria-label="Copy assistant response"
              onAction={(key) =>
                void copyContent(
                  key === "answer-with-activity"
                    ? "answer-with-activity"
                    : "answer",
                )
              }
            >
              <Dropdown.Item id="answer" textValue="Answer only">
                Answer only
              </Dropdown.Item>
              <Dropdown.Item
                id="answer-with-activity"
                textValue="Answer, thinking and tools"
              >
                Answer + thinking &amp; tools
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={copied ? "Response copied" : "Copy response"}
          className="size-7 min-w-7 justify-start p-0"
          onPress={() => void copyContent("answer")}
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-primary" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      )}
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
