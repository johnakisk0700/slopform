import { CheckCircle2, ChevronRight, CircleAlert, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import type { AssistantToolCall } from "../../../features/assistant/schema";

export function AssistantToolCallCard({ call }: { call: AssistantToolCall }) {
  const status = toolStatus(call.state);

  return (
    <details className="jts-disclosure group border-l-2 border-border pl-3 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        {status.icon}
        <span className={call.state === "running" ? "assistant-thinking" : ""}>
          {call.label}
        </span>
        <span className="text-ink-subtle">· {status.label}</span>
        <ChevronRight
          aria-hidden="true"
          className="ml-auto size-3 transition-transform group-open:rotate-90"
        />
      </summary>

      <div className="grid gap-2 pb-2 pl-5 pt-1 text-ink-subtle">
        <ToolPayload
          label="Input"
          value={call.input}
          truncated={call.inputTruncated}
        />
        {call.output !== null ? (
          <ToolPayload
            label="Result"
            value={call.output}
            truncated={call.outputTruncated}
          />
        ) : call.state === "failed" ? (
          <p>The lookup failed; provider internals are intentionally hidden.</p>
        ) : null}
        <p className="font-mono text-[length:var(--jts-text-2xs)] text-ink-subtle">
          {call.tool}
        </p>
      </div>
    </details>
  );
}

function ToolPayload({
  label,
  value,
  truncated,
}: {
  label: string;
  value: AssistantToolCall["input"];
  truncated: boolean;
}) {
  return (
    <section aria-label={`${label} payload`} className="grid gap-1">
      <h4 className="font-semibold text-ink-muted">{label}</h4>
      <pre className="max-h-56 overflow-auto rounded-md border border-border-subtle bg-surface-subtle p-2 font-mono text-[length:var(--jts-text-2xs)] leading-4 text-ink-subtle">
        {value === null ? "No payload" : JSON.stringify(value, null, 2)}
      </pre>
      {truncated ? <p>Stored preview — the full payload was larger.</p> : null}
    </section>
  );
}

function toolStatus(state: AssistantToolCall["state"]): {
  readonly label: string;
  readonly icon: ReactNode;
} {
  switch (state) {
    case "running":
      return {
        label: "running",
        icon: (
          <Wrench
            aria-hidden="true"
            className="size-3.5 shrink-0 text-primary"
          />
        ),
      };
    case "done":
      return {
        label: "done",
        icon: (
          <CheckCircle2
            aria-hidden="true"
            className="size-3.5 shrink-0 text-success"
          />
        ),
      };
    case "failed":
      return {
        label: "failed",
        icon: (
          <CircleAlert
            aria-hidden="true"
            className="size-3.5 shrink-0 text-danger"
          />
        ),
      };
    default:
      return {
        label: "tool",
        icon: (
          <Wrench
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-subtle"
          />
        ),
      };
  }
}
