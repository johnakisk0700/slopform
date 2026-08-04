import { Check, CircleAlert, Loader2, Search, Wrench } from "lucide-react";
import { Fragment, type ReactNode } from "react";

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
      <h4 className="jts-overline text-ink-muted">{label}</h4>
      <pre className="assistant-payload">
        {value === null ? (
          <span className="italic">No payload</span>
        ) : (
          <JsonSyntax value={value} />
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

/**
 * `JSON.stringify(value, null, 2)` with each token wrapped for the
 * `.assistant-payload` palette. Hand-rolled rather than routed through the
 * markdown/highlight pipeline: the value is already parsed JSON, so walking it
 * is both cheaper than re-lexing its serialisation and immune to a payload
 * that happens to contain markdown.
 */
function JsonSyntax({ value }: { value: unknown }) {
  return <>{jsonNodes(value, "")}</>;
}

function jsonNodes(value: unknown, indent: string): ReactNode {
  if (value === null || typeof value === "boolean") {
    return <span className="tok-literal">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="tok-number">{String(value)}</span>;
  }
  if (typeof value === "string") {
    return <span className="tok-string">{JSON.stringify(value)}</span>;
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      <>
        {"[\n"}
        {value.map((item, index) => (
          <Fragment key={index}>
            {inner}
            {jsonNodes(item, inner)}
            {index < value.length - 1 ? "," : ""}
            {"\n"}
          </Fragment>
        ))}
        {`${indent}]`}
      </>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return (
    <>
      {"{\n"}
      {entries.map(([key, entry], index) => (
        <Fragment key={key}>
          {inner}
          <span className="tok-key">{JSON.stringify(key)}</span>
          {": "}
          {jsonNodes(entry, inner)}
          {index < entries.length - 1 ? "," : ""}
          {"\n"}
        </Fragment>
      ))}
      {`${indent}}`}
    </>
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
