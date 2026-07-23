import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

export type JtsStatTone = "success" | "warning";

export interface JtsStatProps {
  /** Micro-caps label (the <dt>). */
  label: string;
  /** The big scannable figure (the <dd>). */
  value: string | number;
  /** Optional supporting line beneath the value. */
  detail?: string;
  /** Toned marker + value + glyph; neutral (wine marker) when omitted. */
  tone?: JtsStatTone;
  /** Optional lucide glyph pinned to the top-right corner. */
  icon?: LucideIcon;
}

const markerByTone: Record<JtsStatTone | "default", string> = {
  default: "border-l-primary",
  success: "border-l-success",
  warning: "border-l-warning",
};

const toneText: Record<JtsStatTone | "default", string> = {
  default: "",
  success: "text-success",
  warning: "text-warning",
};

/**
 * A single stat card. Renders INSIDE a page-owned <dl>: it outputs a card
 * <div> wrapping a <dt> label, a big <dd> value and an optional <dd> detail,
 * with margins reset so the definition list doesn't indent them.
 */
export function JtsStat({
  label,
  value,
  detail,
  tone,
  icon: Icon,
}: JtsStatProps) {
  const key = tone ?? "default";

  return (
    <div
      className={clsx(
        "relative grid min-w-0 rounded-md border border-border border-l-[3px] bg-surface p-5",
        markerByTone[key],
      )}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className={clsx(
            "absolute right-5 top-5",
            tone ? toneText[key] : "text-ink-subtle",
          )}
        >
          <Icon size="1.1rem" />
        </span>
      ) : null}
      <dt className="mb-2 ml-0 mr-10 mt-0 text-xs font-bold uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd
        className={clsx(
          "mx-0 mb-1 mt-0 text-[clamp(2rem,_1.6rem_+_1.2vw,_2.75rem)] font-extrabold leading-none tracking-tighter tabular-nums",
          toneText[key],
        )}
      >
        {value}
      </dd>
      {detail ? <dd className="m-0 text-xs text-ink-muted">{detail}</dd> : null}
    </div>
  );
}
