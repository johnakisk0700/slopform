import { Check, CircleAlert, Loader2, Search, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import type { AssistantToolCall } from "../../../features/assistant/schema";
import { AssistantActivityDisclosure } from "./AssistantActivityDisclosure";

export function AssistantToolCallCard({ call }: { call: AssistantToolCall }) {
  const status = toolStatus(call.state);
  const detail = toolDetail(call.input);

  return (
    <AssistantActivityDisclosure
      tone="tool"
      label={call.label}
      {...(call.state === "running"
        ? { labelClassName: "assistant-thinking" }
        : {})}
      detail={detail}
      icon={
        <Search aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      }
      trailing={status.icon}
    >
      <div className="grid gap-2 px-2.5 py-2 text-ink-subtle">
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
          {call.tool} · {status.label}
        </p>
      </div>
    </AssistantActivityDisclosure>
  );
}

function toolDetail(input: AssistantToolCall["input"]): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const values = input as Record<string, unknown>;
  for (const key of ["query", "search", "name", "title", "email", "status"]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
        icon: <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />,
      };
    case "done":
      return {
        label: "done",
        icon: (
          <Check
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
