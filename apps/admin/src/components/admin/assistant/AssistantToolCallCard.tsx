import { Check, CircleAlert, Loader2, Search } from "lucide-react";

import type { AssistantToolCall } from "../../../features/assistant/schema";
import { AssistantActivityDisclosure } from "./AssistantActivityDisclosure";

export function AssistantToolCallCard({ call }: { call: AssistantToolCall }) {
  const StatusIcon = TOOL_STATUS_ICONS[call.state];
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
      trailing={
        <StatusIcon
          aria-hidden="true"
          className={`size-3.5 shrink-0 ${
            call.state === "running"
              ? "animate-spin"
              : call.state === "done"
                ? "text-success"
                : "text-danger"
          }`}
        />
      }
    >
      <div className="grid gap-2 px-2.5 py-2 text-ink-muted">
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
          {call.tool} · {call.state}
        </p>
      </div>
    </AssistantActivityDisclosure>
  );
}

function toolDetail(input: AssistantToolCall["input"]): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  for (const key of ["query", "search", "name", "title", "email", "status"]) {
    const value = input[key];
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
      <h4 className="jts-overline text-ink-muted">{label}</h4>
      <pre className="assistant-payload">
        {value === null ? (
          <span className="italic">No payload</span>
        ) : (
          JSON.stringify(value, null, 2)
        )}
      </pre>
      {truncated ? (
        <p className="text-ink-subtle">
          Stored preview — the full payload was larger.
        </p>
      ) : null}
    </section>
  );
}

const TOOL_STATUS_ICONS = {
  running: Loader2,
  done: Check,
  failed: CircleAlert,
} as const;
