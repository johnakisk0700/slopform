import {
  Button,
  Description,
  ErrorMessage,
  Label,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { ArrowUp } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type RefObject } from "react";

import type {
  AssistantEffort,
  AssistantModel,
} from "../../../features/assistant/schema";
import { AssistantModelSelector } from "./AssistantModelSelector";

interface AssistantComposerProps {
  value: string;
  selectedModel: AssistantModel;
  selectedEffort: AssistantEffort;
  isBusy: boolean;
  isBlocked: boolean;
  error: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onModelChange: (model: AssistantModel) => void;
  onEffortChange: (effort: AssistantEffort) => void;
  onSubmit: () => void;
}

/** Bottom-docked composer ported from notes_ai's MainTextarea structure. */
export function AssistantComposer({
  value,
  selectedModel,
  selectedEffort,
  isBusy,
  isBlocked,
  error,
  textareaRef,
  onChange,
  onModelChange,
  onEffortChange,
  onSubmit,
}: AssistantComposerProps) {
  const disabled = isBusy || isBlocked;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!disabled) onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-3 sm:px-5">
      <form
        onSubmit={submit}
        className="pointer-events-auto relative w-[45rem] max-w-full rounded-t-xl border border-b-0 border-border bg-surface/95 px-4 pt-3.5 pb-2 shadow-lg backdrop-blur-md transition-colors focus-within:border-primary-border focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary-border"
      >
        <TextField
          fullWidth
          isDisabled={disabled}
          isInvalid={Boolean(error)}
          aria-describedby="assistant-composer-help"
        >
          <Label htmlFor="assistant-composer" className="sr-only">
            Message the assistant
          </Label>
          <div className="flex items-start gap-2">
            <span
              className="select-none text-sm leading-5 text-primary/70"
              aria-hidden="true"
            >
              ❯
            </span>
            <TextArea
              ref={textareaRef}
              id="assistant-composer"
              value={value}
              rows={2}
              maxLength={20_000}
              placeholder={
                isBlocked
                  ? "Retry the failed turn or start a new conversation"
                  : "Ask anything about Join The Six operations…"
              }
              className="max-h-40 min-h-12 w-full resize-y border-0 bg-transparent p-0 text-sm shadow-none outline-none focus:border-0 focus:bg-transparent focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          {error ? (
            <ErrorMessage className="mt-1.5">{error}</ErrorMessage>
          ) : null}

          <div className="mt-1.5 flex w-full items-center gap-2 border-t border-border-subtle pt-2 pb-1.5">
            <AssistantModelSelector
              value={selectedModel}
              effort={selectedEffort}
              isDisabled={disabled}
              onChange={onModelChange}
              onEffortChange={onEffortChange}
            />
            <Description
              id="assistant-composer-help"
              className="hidden text-xs text-ink-subtle sm:block"
            >
              Enter sends · Shift+Enter adds a line
            </Description>
            <Button
              type="submit"
              variant="primary"
              isIconOnly
              isDisabled={disabled || !value.trim()}
              aria-label="Send message"
              className="ml-auto size-8.5 min-w-8.5 rounded-md"
            >
              {isBusy ? (
                <Spinner color="current" size="sm" aria-hidden="true" />
              ) : (
                <ArrowUp aria-hidden="true" className="size-4" />
              )}
            </Button>
          </div>
        </TextField>
      </form>
    </div>
  );
}
