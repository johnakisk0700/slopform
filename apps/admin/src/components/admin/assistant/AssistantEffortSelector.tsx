import { Brain } from "lucide-react";

import {
  ASSISTANT_EFFORTS,
  type AssistantEffort,
} from "../../../features/assistant/schema";

const LABELS: Record<AssistantEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

interface AssistantEffortSelectorProps {
  value: AssistantEffort;
  onChange: (effort: AssistantEffort) => void;
}

/** Compact reasoning-effort control copied from notes_ai's model popover. */
export function AssistantEffortSelector({
  value,
  onChange,
}: AssistantEffortSelectorProps) {
  return (
    <div
      className="flex w-full items-center justify-between"
      role="group"
      aria-label="Reasoning effort"
    >
      <span className="flex items-center gap-1.5 text-ink-muted" aria-hidden>
        <Brain className="size-3.5 shrink-0" />
        <span className="text-xs">Thinking</span>
      </span>
      <div className="flex items-center gap-0.5">
        {ASSISTANT_EFFORTS.map((effort) => (
          <button
            key={effort}
            type="button"
            aria-pressed={value === effort}
            onClick={() => onChange(effort)}
            className={`rounded-sm px-2 py-1 text-[length:var(--jts-text-2xs)] transition-colors ${
              value === effort
                ? "bg-primary-soft font-semibold text-primary"
                : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
            }`}
          >
            {LABELS[effort]}
          </button>
        ))}
      </div>
    </div>
  );
}
