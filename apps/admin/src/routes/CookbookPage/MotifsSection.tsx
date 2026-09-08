import { clsx } from "clsx";
import { Check } from "lucide-react";

import { BrandLockup } from "../../components/admin/BrandLockup";

import { MOTIF_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";

export function MotifsSection() {
  return (
    <Section spec={MOTIF_SECTION}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen
          label="The six-dot mark — under a title"
          note="Five dots in the theme's primary and a sixth in its accent: the table, and the seat still open. It belongs to page titles alone, and it replaced the plain 3px dash every h1 used to carry."
          className="grid gap-2"
        >
          <p className="jts-title-mark font-display text-[1.375rem] font-extrabold text-ink">
            Operations control
          </p>
        </Specimen>

        <Specimen
          label="The 3px marker — vertical"
          note="On the left edge of a card, in wine or in a status tone. The horizontal dash that used to pair with it now belongs to the six-dot mark, so these two are the whole vocabulary."
          className="grid gap-2"
        >
          <p className="rounded-md border border-border border-l-[3px] border-l-primary bg-surface-sunken px-3 py-2 text-sm text-ink">
            border-l-[3px] border-l-primary
          </p>
          <p className="rounded-md border border-border border-l-[3px] border-l-success bg-surface-sunken px-3 py-2 text-sm text-ink">
            border-l-[3px] border-l-success
          </p>
          <p className="rounded-md border border-border border-l-[3px] border-l-warning bg-surface-sunken px-3 py-2 text-sm text-ink">
            border-l-[3px] border-l-warning
          </p>
        </Specimen>

        <Specimen
          label="Brand lockup"
          note="SVG form/chat mark via currentColor + the Sora wordmark (`font-brand`, the wordmark's own face — never UI copy). The mark takes the theme brand on its slab (`sidebar-active-index` on strong, `primary` on paper); the wordmark inherits the parent tone. With a tagline the mark steps up to 40px and both lines set solid, so the three parts read as one block."
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
          label="Six-dot motif & status dot"
          note="The CSS six-dot `.brand-mark` is a decorative motif only (empty states) — not the product logo. The status dot is the one environment indicator: static, never pulsing, never glowing."
        >
          <span aria-hidden="true" className="brand-mark text-primary" />
          <span aria-hidden="true" className="brand-mark text-copper" />
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
  "The 3px marker is the only emphasis motif. No glows, gradient washes, blurred circles or pulsing dots.",
  "A badge always carries its own label; tone is reinforcement, never the signal.",
  "The `dark` class on <html> is the only theme signal. Components never branch on the theme — the tokens already flipped.",
  "Metadata labels are `jts-overline`, not a hand-written size/weight/tracking triple.",
  "Numbers that get compared use `tabular-nums`; machine strings use `font-mono`.",
];
