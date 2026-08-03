import { Brain, ChevronRight } from "lucide-react";
import { useState } from "react";

/**
 * The model's own account of its thinking, as a quiet disclosure — the shape
 * notes_ai uses for the same part.
 *
 * Collapsed by default and never styled as prose: this is not the answer, and a
 * reader who mistakes reasoning for a result has been misled by the layout. It
 * The provider stops sending it when the turn settles; the durable turn keeps
 * the final accumulated value so the same disclosure survives reload.
 */
export function AssistantReasoningCard({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mb-2 border-l-2 border-border pl-3">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
      >
        <Brain aria-hidden="true" className="size-3.5 shrink-0" />
        <span className={streaming ? "assistant-thinking" : undefined}>
          Thinking
        </span>
        <ChevronRight
          aria-hidden="true"
          className={`size-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
        />
      </button>

      {isOpen ? (
        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-ink-subtle">
          {reasoning}
        </p>
      ) : null}
    </div>
  );
}
