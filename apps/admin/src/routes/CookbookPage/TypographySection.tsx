import { clsx } from "clsx";

import { TYPE_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";

export function TypographySection() {
  return (
    <Section spec={TYPE_SECTION}>
      <Specimen
        label="Scale"
        note="Display samples use Commissioner; UI/body stays Manrope. Both carry Latin and Greek so either language reads as the same page."
        className="grid gap-3"
      >
        {TYPE_STEPS.map((step) => (
          <div
            key={step.token}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border-subtle pb-2 last:border-b-0 last:pb-0"
          >
            <span
              className={clsx(
                "min-w-0 font-display leading-tight font-bold text-ink",
                step.utility,
              )}
            >
              {step.sample}
            </span>
            <code className="shrink-0 font-mono text-xs text-ink-subtle">
              {step.token}
            </code>
          </div>
        ))}
      </Specimen>

      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen label="Weights" className="grid gap-1.5">
          {WEIGHTS.map((weight) => (
            <div
              key={weight.utility}
              className="flex flex-wrap items-baseline justify-between gap-x-4"
            >
              <span className={clsx("text-sm text-ink", weight.utility)}>
                Έξι στο τραπέζι · Six at a table
              </span>
              <code className="font-mono text-xs text-ink-subtle">
                {weight.token}
              </code>
            </div>
          ))}
        </Specimen>

        <Specimen label="Tracking & the overline recipe" className="grid gap-2">
          <p className="text-sm tracking-tighter text-ink">
            tracking-tighter · Δείπνο στο Κολωνάκι
          </p>
          <p className="text-sm tracking-tight text-ink">
            tracking-tight · Δείπνο στο Κολωνάκι
          </p>
          <p className="text-sm tracking-wide text-ink">
            tracking-wide · Δείπνο στο Κολωνάκι
          </p>
          <p className="jts-overline text-ink-muted">
            jts-overline · waiting · αναμονή
          </p>
          <p className="text-xs text-ink-subtle">
            Every metadata label on every screen is that one utility — four
            declarations no single `@theme` entry can express.
          </p>
        </Specimen>

        <Specimen
          label="Figures"
          note="Tabular for anything an operator compares down a column; proportional for prose."
          className="grid grid-cols-2 gap-4"
        >
          <dl className="grid gap-1">
            <dt className="jts-overline text-ink-muted">tabular-nums</dt>
            {FIGURE_ROWS.map((row) => (
              <dd
                key={row.label}
                className="m-0 flex justify-between text-sm tabular-nums text-ink"
              >
                <span className="text-ink-muted">{row.label}</span>
                {row.value}
              </dd>
            ))}
          </dl>
          <dl className="grid gap-1">
            <dt className="jts-overline text-ink-muted">proportional</dt>
            {FIGURE_ROWS.map((row) => (
              <dd
                key={row.label}
                className="m-0 flex justify-between text-sm text-ink"
              >
                <span className="text-ink-muted">{row.label}</span>
                {row.value}
              </dd>
            ))}
          </dl>
        </Specimen>

        <Specimen
          label="Machine strings"
          note="font-mono is for values an operator copies or compares — ids, model names, millisecond times. Never for prose."
          className="grid gap-1.5"
        >
          <code className="font-mono text-xs text-ink">
            c8f4a1d2-77e1-4b90-9a03-1f6b2c5d8e40
          </code>
          <code className="font-mono text-xs text-ink">gpt-5.1-mini</code>
          <code className="font-mono text-xs text-ink">
            2026-08-01 21:14:42.318
          </code>
        </Specimen>
      </div>
    </Section>
  );
}

interface TypeStep {
  token: string;
  utility: string;
  sample: string;
}

// The bridge maps colour, radius, shadow and tracking into Tailwind's theme but
// deliberately not the type scale, so a jts size is written as an arbitrary
// value that references the token. That is the pattern to copy — never a
// hand-picked rem.
const TYPE_STEPS: readonly TypeStep[] = [
  {
    token: "--jts-text-3xl",
    utility: "text-[length:var(--jts-text-3xl)]",
    sample: "Slopform",
  },
  {
    token: "--jts-text-2xl",
    utility: "text-[length:var(--jts-text-2xl)]",
    sample: "Έξι στο τραπέζι",
  },
  {
    token: "--jts-text-xl",
    utility: "text-[length:var(--jts-text-xl)]",
    sample: "Operations control",
  },
  {
    token: "--jts-text-lg",
    utility: "text-[length:var(--jts-text-lg)]",
    sample: "Outbound queue",
  },
  {
    token: "--jts-text-md",
    utility: "text-[length:var(--jts-text-md)]",
    sample: "Δείπνο στο Κολωνάκι, Πέμπτη 20:30",
  },
  {
    token: "--jts-text-sm",
    utility: "text-[length:var(--jts-text-sm)]",
    sample: "Έξι άνθρωποι, ένα τραπέζι, μία βραδιά.",
  },
  {
    token: "--jts-text-xs",
    utility: "text-[length:var(--jts-text-xs)]",
    sample: "Queued 4 minutes ago · campaign launched",
  },
  {
    token: "--jts-text-2xs",
    utility: "text-[length:var(--jts-text-2xs)]",
    sample: "Waiting · αναμονή",
  },
];

// `utility` is both the label and the class applied. Tailwind's scanner reads
// source text, so a literal in this array emits its rule; a class assembled by
// interpolation would emit nothing and the specimen would quietly lie.
const WEIGHTS: readonly { utility: string; token: string }[] = [
  { utility: "font-normal", token: "--jts-weight-regular" },
  { utility: "font-medium", token: "--jts-weight-medium" },
  { utility: "font-semibold", token: "--jts-weight-semibold" },
  { utility: "font-bold", token: "--jts-weight-bold" },
  { utility: "font-extrabold", token: "--jts-weight-extrabold" },
];

const FIGURE_ROWS: readonly { label: string; value: string }[] = [
  { label: "Delivered", value: "1.148" },
  { label: "Waiting", value: "97" },
  { label: "Failed", value: "1.011" },
  { label: "Opened", value: "808" },
];
