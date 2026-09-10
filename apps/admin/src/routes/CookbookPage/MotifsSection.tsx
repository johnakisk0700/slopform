import { clsx } from "clsx";
import { Check, CircleAlert, Clock, Hash } from "lucide-react";

import { BrandLockup } from "../../components/admin/BrandLockup";
import { BrandMark } from "../../components/admin/BrandMark";

import { MOTIF_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";

export function MotifsSection() {
  return (
    <Section spec={MOTIF_SECTION}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen
          label="Page titles"
          note="Bold Manrope with a quiet hashtag floating to the left. The marker stays beside the first line when a title wraps."
          className="grid gap-2"
        >
          <p className="jts-page-title font-display text-[1.375rem] font-bold leading-tight text-ink">
            <Hash aria-hidden="true" className="jts-page-title-mark" />
            Operations control
          </p>
          <p className="text-sm text-ink-muted">
            Your conversations and upcoming events.
          </p>
        </Specimen>

        <Specimen
          label="Attention: icon, label and soft fill"
          note="Compact badges pair a readable label with an icon and semantic fill. Attention stays visible without filling the card's width."
          className="flex flex-wrap items-center gap-2"
        >
          <span className="inline-flex items-center gap-1 rounded-full border border-danger-border bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
            <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
            Needs attention
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
            <Clock aria-hidden="true" className="size-3 shrink-0" />
            Waiting too long
          </span>
        </Specimen>

        <Specimen
          label="Brand lockup"
          note="The two-piece S and Sora wordmark form the shared lockup. The mark keeps its rose/wine identity on light surfaces and uses a light lower curve on dark or strong surfaces. Noir uses neutral fills. With a tagline, the mark grows to 40px."
          className="grid gap-4"
        >
          <div className="rounded-md bg-sidebar px-4 py-3 text-sidebar-fg">
            <BrandLockup
              surface="strong"
              tagline="Admin workspace"
              taglineClassName="text-sidebar-fg-muted"
            />
          </div>
          <BrandLockup surface="default" className="text-ink" />
        </Specimen>

        <Specimen
          label="Product mark & environment indicator"
          note="The same filled curves and open channel at 16, 24, 36 and 64px. The small status dot remains reserved for the environment indicator."
          className="grid gap-4"
        >
          <div className="flex flex-wrap items-end gap-6">
            {[
              { label: "16px", className: "size-4" },
              { label: "24px", className: "size-6" },
              { label: "36px", className: "size-9" },
              { label: "64px", className: "size-16" },
            ].map(({ label, className }) => (
              <span key={label} className="grid justify-items-center gap-2">
                <BrandMark className={className} />
                <span className="text-xs text-ink-muted">{label}</span>
              </span>
            ))}
          </div>
          <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
            <span aria-hidden="true" className="status-dot" />
            Local · connected
          </span>
        </Specimen>

        <Specimen label="Radius" className="flex flex-wrap items-end gap-3">
          {RADII.map((radius) => (
            <span
              key={radius.utility}
              className="grid justify-items-center gap-1"
            >
              <span
                aria-hidden="true"
                className={clsx(
                  "size-12 border border-border bg-surface-sunken",
                  radius.utility,
                )}
              />
              <code className="font-mono text-[length:var(--jts-text-2xs)] text-ink-subtle">
                {radius.utility}
              </code>
            </span>
          ))}
        </Specimen>

        <Specimen
          label="Elevation"
          note="Surfaces are flat; shadow belongs to things that float. The scale deepens in dark rather than switching to a glow."
          className="flex flex-wrap items-end gap-4"
        >
          {SHADOWS.map((shadow) => (
            <span
              key={shadow.utility}
              className="grid justify-items-center gap-1"
            >
              <span
                aria-hidden="true"
                className={clsx(
                  "size-12 rounded-md bg-surface-raised",
                  shadow.utility,
                )}
              />
              <code className="font-mono text-[length:var(--jts-text-2xs)] text-ink-subtle">
                {shadow.utility}
              </code>
            </span>
          ))}
        </Specimen>

        <Specimen
          label="The rules this page exists to protect"
          className="grid"
        >
          <ul className="grid gap-1.5">
            {INVARIANTS.map((rule) => (
              <li
                key={rule}
                className="flex items-start gap-2 text-sm text-ink-muted"
              >
                <Check
                  aria-hidden="true"
                  className="mt-1 size-3.5 shrink-0 text-primary"
                />
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </Specimen>
      </div>
    </Section>
  );
}

const RADII: readonly { utility: string; token: string }[] = [
  { utility: "rounded-xs", token: "--jts-radius-xs" },
  { utility: "rounded-sm", token: "--jts-radius-sm" },
  { utility: "rounded-md", token: "--jts-radius-md" },
  { utility: "rounded-lg", token: "--jts-radius-lg" },
  { utility: "rounded-xl", token: "--jts-radius-xl" },
];

const SHADOWS: readonly { utility: string; token: string }[] = [
  { utility: "shadow-xs", token: "--jts-shadow-xs" },
  { utility: "shadow-sm", token: "--jts-shadow-sm" },
  { utility: "shadow-md", token: "--jts-shadow-md" },
  { utility: "shadow-lg", token: "--jts-shadow-lg" },
];

const INVARIANTS: readonly string[] = [
  "Colour comes from a semantic token through a bridge utility. No hex, no rgb, no oklch, no default Tailwind palette class, no inline style colour.",
  "Attention uses a labelled icon and a semantic soft fill. Ordinary card outlines stay neutral.",
  "A badge always carries its own label; tone is reinforcement, never the signal.",
  "The `dark` class on <html> is the only theme signal. Components never branch on the theme — the tokens already flipped.",
  "Metadata labels are `jts-overline`, not a hand-written size/weight/tracking triple.",
  "Field icons accompany visible, sentence-case labels; they never replace the label or invent a missing value.",
  "Numbers that get compared use `tabular-nums`; machine strings use `font-mono`.",
];
