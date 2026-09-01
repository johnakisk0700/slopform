import {
  Button,
  Description,
  ErrorMessage,
  Label,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { ArrowUp, Zap } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type RefObject } from "react";

import {
  assistantModelSupportsServiceTier,
  type AssistantEffort,
  type AssistantModel,
  type AssistantServiceTier,
} from "../../../features/assistant/schema";
import { AssistantModelSelector } from "./AssistantModelSelector";

interface AssistantComposerProps {
  value: string;
  selectedModel: AssistantModel;
  selectedEffort: AssistantEffort;
  selectedServiceTier: AssistantServiceTier;
  isBusy: boolean;
  isLoading: boolean;
  isBlocked: boolean;
  error: string | null;
  containerRef: RefObject<HTMLFormElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onModelChange: (model: AssistantModel) => void;
  onEffortChange: (effort: AssistantEffort) => void;
  onServiceTierChange: (tier: AssistantServiceTier) => void;
  onSubmit: () => void;
}

/** Bottom-docked composer ported from notes_ai's MainTextarea structure. */
export function AssistantComposer({
  value,
  selectedModel,
  selectedEffort,
  selectedServiceTier,
  isBusy,
  isLoading,
  isBlocked,
  error,
  containerRef,
  textareaRef,
  onChange,
  onModelChange,
  onEffortChange,
  onServiceTierChange,
  onSubmit,
}: AssistantComposerProps) {
  const disabled = isBusy || isBlocked;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!disabled && !isLoading) onSubmit();
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
        ref={containerRef}
        onSubmit={submit}
        className="pointer-events-auto relative w-[45rem] max-w-full rounded-t-xl border border-b-0 border-border bg-surface/95 px-4 pt-3.5 pb-2 shadow-lg backdrop-blur-md transition-colors focus-within:border-primary-border"
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
            {/* Mono, like the source: the sans "❯" is drawn with no descender at
                all, so it hangs off its own baseline. The nudge is measured
                against the ink of the text beside it, which is what the eye
                actually compares the glyph to — not against the line box, whose
                half-leading is symmetric and hides the offset. Mono "❯" ink
                centres 1.1px above that band; +1px closes it. */}
            <span
              className="translate-y-px select-none font-mono text-sm leading-5 text-primary/70"
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
                  : "Ask anything about Slopform operations…"
              }
              // Two fixed rows that scroll, exactly like the source composer: a
              // drag handle here would resize a box the page docks against.
              //
              // Horizontal padding is the browser's own 2px, which the source
              // never resets. A textarea clips at its padding box, so with it
              // zeroed the caret is painted straight onto that edge and loses
              // half its width. Vertical padding stays zero — that is what puts
              // the first line on the prompt's line.
              className="w-full resize-none border-0 bg-transparent px-0.5 py-0 text-sm shadow-none outline-none focus:border-0 focus:bg-transparent focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
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
            <AssistantFastLaneToggle
              value={selectedServiceTier}
              isSupported={assistantModelSupportsServiceTier(selectedModel)}
              isDisabled={disabled}
              onChange={onServiceTierChange}
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
              isDisabled={disabled || isLoading || !value.trim()}
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

/**
 * The fast-lane toggle.
 *
 * Disabled rather than hidden on the OpenRouter models: a control that vanishes
 * teaches nothing, while a disabled one with a reason explains why this model
 * cannot be hurried. The label carries the price, because doubling the bill is
 * the entire trade and an operator should not have to remember it.
 */
function AssistantFastLaneToggle({
  value,
  isSupported,
  isDisabled,
  onChange,
}: {
  value: AssistantServiceTier;
  isSupported: boolean;
  isDisabled: boolean;
  onChange: (tier: AssistantServiceTier) => void;
}) {
  const isOn = isSupported && value === "fast";

  const explanation = isSupported
    ? "Fast lane — about twice the speed at twice the token price"
    : "Fast lane is an OpenAI setting; this model runs through OpenRouter";

  // The tooltip sits on the wrapper, not the button: a disabled control stops
  // firing the pointer events a title needs, and the disabled case is precisely
  // the one that has something to explain.
  return (
    <span title={explanation} className="inline-flex">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        isDisabled={isDisabled || !isSupported}
        aria-pressed={isOn}
        aria-label={explanation}
        className={`h-8 gap-1.5 rounded-sm px-2 text-xs ${
          isOn ? "bg-primary-soft text-primary" : "text-ink-muted"
        }`}
        onPress={() => onChange(isOn ? "standard" : "fast")}
      >
        <Zap aria-hidden="true" className="size-3.5" />
        Fast
      </Button>
    </span>
  );
}
