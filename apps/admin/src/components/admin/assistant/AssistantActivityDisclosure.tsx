import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

interface AssistantActivityDisclosureProps {
  readonly label: string;
  readonly icon: ReactNode;
  readonly trailing?: ReactNode;
  readonly detail?: string | null;
  readonly tone: "tool" | "reasoning";
  readonly labelClassName?: string;
  readonly children: ReactNode;
}

/**
 * The Notes AI activity chip, adapted only to Join The Six theme tokens.
 * Tool calls and reasoning deliberately share this exact summary row so their
 * baseline, padding and collapsed height cannot drift independently again.
 */
export function AssistantActivityDisclosure({
  label,
  icon,
  trailing,
  detail,
  tone,
  labelClassName,
  children,
}: AssistantActivityDisclosureProps) {
  return (
    <details
      className={clsx(
        "jts-disclosure group my-1.5 rounded-lg border text-xs",
        tone === "tool"
          ? "border-primary-border bg-primary-soft"
          : "border-border bg-surface-sunken",
      )}
    >
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-left text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        {icon}
        <span className={clsx("shrink-0 font-medium", labelClassName)}>
          {label}
        </span>
        {detail ? (
          <span className="truncate text-ink-subtle">: “{detail}”</span>
        ) : null}
        {trailing ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-ink-subtle">
            {trailing}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-border-subtle">{children}</div>
    </details>
  );
}
