import { type ReactNode } from "react";

import { type SectionSpec } from "./cookbookSections";

export function Section({
  spec,
  children,
}: {
  spec: SectionSpec;
  children: ReactNode;
}) {
  const { Icon } = spec;

  return (
    // `scroll-mt` clears the small-screen sticky header, which would otherwise
    // land every anchor jump underneath it.
    <section
      id={spec.id}
      aria-labelledby={`${spec.id}-heading`}
      className="grid scroll-mt-24 gap-3"
    >
      <div className="border-b border-border pb-2">
        <h2
          id={`${spec.id}-heading`}
          className="flex items-center gap-2 text-[1.05rem] font-bold tracking-tight text-ink"
        >
          <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
          {spec.title}
        </h2>
        <p className="mt-1 max-w-[70ch] text-sm text-ink-muted">{spec.lede}</p>
      </div>
      {children}
    </section>
  );
}

export function Specimen({
  label,
  note,
  children,
  className,
}: {
  label: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-2 rounded-md border border-border bg-surface p-4">
      <p className="jts-overline text-ink-muted">{label}</p>
      <div className={className ?? "flex flex-wrap items-center gap-3"}>
        {children}
      </div>
      {note ? <p className="text-xs text-ink-subtle">{note}</p> : null}
    </div>
  );
}
