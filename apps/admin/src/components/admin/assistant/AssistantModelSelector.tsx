import { Button, Popover } from "@heroui/react";
import { Brain, ChevronDown } from "lucide-react";

import {
  ASSISTANT_MODELS,
  type AssistantEffort,
  type AssistantModel,
} from "../../../features/assistant/schema";
import { AssistantEffortSelector } from "./AssistantEffortSelector";
import { AssistantProviderIcon } from "./AssistantProviderIcon";

interface AssistantModelSelectorProps {
  value: AssistantModel;
  effort: AssistantEffort;
  isDisabled: boolean;
  onChange: (model: AssistantModel) => void;
  onEffortChange: (effort: AssistantEffort) => void;
}

const EFFORT_SHORT: Record<AssistantEffort, string> = {
  low: "L",
  medium: "M",
  high: "H",
};

const BRAND_TONE = {
  openai: "text-primary",
  google: "text-info",
  qwen: "text-copper",
} as const;

/**
 * Compact model settings surface, ported from notes_ai's chat toolbar. The
 * selector stays next to the composer rather than becoming page chrome.
 */
export function AssistantModelSelector({
  value,
  effort,
  isDisabled,
  onChange,
  onEffortChange,
}: AssistantModelSelectorProps) {
  const current =
    ASSISTANT_MODELS.find((model) => model.id === value) ?? ASSISTANT_MODELS[0];

  if (!current) return null;

  return (
    <Popover>
      <Button
        variant="ghost"
        size="sm"
        isDisabled={isDisabled}
        className="h-8 gap-1.5 rounded-sm px-2 text-xs [&_svg]:m-0"
      >
        <AssistantProviderIcon
          brand={current.brand}
          className={`size-4 opacity-75 ${BRAND_TONE[current.brand]}`}
        />
        <span className="max-w-36 truncate">{current.label}</span>
        <span
          className="flex items-center gap-0.5 border-l border-border-subtle pl-1.5 text-[length:var(--jts-text-2xs)] text-ink-muted"
          title={`Reasoning effort: ${effort}`}
        >
          <Brain aria-hidden="true" className="size-3" />
          {EFFORT_SHORT[effort]}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 opacity-60" />
      </Button>

      <Popover.Content
        placement="top start"
        offset={6}
        className="w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-0 shadow-md"
      >
        <Popover.Dialog aria-label="Choose assistant model" className="p-2">
          <div className="flex flex-col gap-1.5">
            {ASSISTANT_MODELS.map((model) => {
              const selected = model.id === value;

              return (
                <button
                  key={model.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChange(model.id)}
                  className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? "border-primary-border bg-primary-soft"
                      : "border-border-subtle hover:border-border-strong hover:bg-surface-sunken"
                  }`}
                >
                  <AssistantProviderIcon
                    brand={model.brand}
                    className={`size-6 ${BRAND_TONE[model.brand]} ${
                      selected ? "opacity-100" : "opacity-60"
                    }`}
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex items-center gap-2">
                      <strong className="truncate text-sm text-ink">
                        {model.label}
                      </strong>
                      <span className="shrink-0 rounded border border-border px-1 py-px text-[length:var(--jts-text-2xs)] leading-none text-ink-muted">
                        {model.provider}
                      </span>
                    </span>
                    <span className="truncate text-xs text-ink-muted">
                      {model.description}
                    </span>
                  </span>
                  <span
                    title="Reasoning model"
                    className={selected ? "text-primary" : "text-ink-subtle"}
                  >
                    <Brain aria-hidden="true" className="size-4" />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 px-3">
            <AssistantEffortSelector value={effort} onChange={onEffortChange} />
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
