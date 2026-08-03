import { Brain, Loader2 } from "lucide-react";

import { AssistantActivityDisclosure } from "./AssistantActivityDisclosure";

/**
 * The model's own account of its thinking, as a quiet disclosure — the shape
 * notes_ai uses for the same part.
 *
 * Collapsed by default and never styled as prose: this is not the answer, and a
 * reader who mistakes reasoning for a result has been misled by the layout.
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
  return (
    <AssistantActivityDisclosure
      tone="reasoning"
      label="Thinking"
      labelClassName="font-mono"
      icon={
        <Brain aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      }
      trailing={
        streaming ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : null
      }
    >
      <div className="whitespace-pre-wrap break-words px-2.5 py-2 text-[0.8rem] italic leading-relaxed text-ink-muted">
        {reasoning}
      </div>
    </AssistantActivityDisclosure>
  );
}
