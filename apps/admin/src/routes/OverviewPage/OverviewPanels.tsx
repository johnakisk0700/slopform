import { Chip } from "@heroui/react";
import clsx from "clsx";
import { Inbox } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";

import { type QueueItem, type StampTone, stampToneText } from "./overviewData";

/**
 * A compact HeroUI status chip with a visible label and semantic tone.
 */
export function Stamp({
  tone,
  children,
}: {
  tone: StampTone;
  children: ReactNode;
}) {
  return (
    <Chip
      variant="tertiary"
      className={clsx(
        "rounded-sm border border-current/40 bg-transparent px-2 py-0.5 jts-overline",
        stampToneText[tone],
      )}
    >
      {children}
    </Chip>
  );
}

/** A copper informational aside (contract motif #6). */
export function CopperNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-md border border-copper/35 bg-copper-soft px-4 py-3 text-sm text-ink-muted"
    >
      <Inbox
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-copper"
      />
      <span>{children}</span>
    </div>
  );
}

/** A focus card with a short context label above the title. */
export function FocusCard({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-md border border-border bg-surface p-6">
      <p className="mb-2 jts-overline text-ink-muted">{kicker}</p>
      <h2 className="mb-4 text-[1.05rem] font-bold tracking-tight text-ink">
        {title}
      </h2>
      {children}
    </article>
  );
}

/** A single receipt-ruled row in the operator attention queue. */
export function QueueRow({
  icon: Icon,
  title,
  subtitle,
  stampTone,
  stampLabel,
  to,
}: QueueItem) {
  return (
    <li className="first:pt-0 last:pb-0">
      <Link
        to={to}
        className="-mx-1 flex items-center gap-3 rounded-md px-1 py-3 text-inherit no-underline transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
      >
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"
        >
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <strong className="font-bold text-ink">{title}</strong>
          <small className="text-xs text-ink-muted">{subtitle}</small>
        </span>
        <span className="ml-auto">
          <Stamp tone={stampTone}>{stampLabel}</Stamp>
        </span>
      </Link>
    </li>
  );
}
