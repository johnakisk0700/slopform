import { clsx } from "clsx";

import { COLOUR_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";

export function ColourSection() {
  return (
    <Section spec={COLOUR_SECTION}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen
          label="Canvas & surfaces"
          note="Warm oat paper in light, warm espresso in dark — a quiet field either way, so the wine reads as action. Cards lift by surface, not by shadow."
        >
          <SwatchGrid swatches={SURFACE_SWATCHES} />
        </Specimen>

        <Specimen
          label="Borders"
          note="Hairlines only. `border-*-border` names exist because HeroUI models a status as fill + soft fill + text and stops there."
        >
          <SwatchGrid swatches={BORDER_SWATCHES} />
        </Specimen>

        <Specimen
          label="Ink"
          note="Shown as text, because a text token is only worth auditing at the size it is read."
        >
          <InkList specimens={INK_SPECIMENS} mutedTone="text-ink-subtle" />
        </Specimen>

        <div className="grid content-start gap-2 rounded-md border border-border bg-surface-strong p-4">
          <p className="jts-overline text-on-strong-muted">
            Ink on the inverse surface
          </p>
          <InkList
            specimens={ON_STRONG_SPECIMENS}
            mutedTone="text-on-strong-muted"
          />
          <p className="text-xs text-on-strong-muted">
            The wine sidebar is wine in both themes, so these two carry no dark
            override.
          </p>
        </div>

        <Specimen label="Brand — wine">
          <SwatchGrid swatches={BRAND_SWATCHES} />
          <p className="flex w-full items-center gap-2 rounded-sm bg-primary px-2 py-1 text-xs font-semibold text-primary-contrast">
            <code className="font-mono">text-primary-contrast</code>
            <span className="opacity-80">on bg-primary</span>
          </p>
        </Specimen>

        <Specimen
          label="Accent, link, focus, selection"
          note="Copper is the one warm secondary accent, and it carries its own label: every theme clears AA for its accent on surface and on its own tint. It sits at least ΔE 12 from each status tone, so an accent pill is never mistaken for a warning."
        >
          <SwatchGrid swatches={ACCENT_SWATCHES} />
        </Specimen>

        <Specimen
          label="Sidebar family"
          note="Composed from the tokens above; the live sidebar to the left is the other half of this audit."
        >
          <SwatchGrid swatches={SIDEBAR_SWATCHES} />
        </Specimen>

        <Specimen
          label="Focus ring, for real"
          note="Native controls take the global 2px outline plus --jts-focus-ring; HeroUI components manage their own, so they are never double-ringed."
          className="grid gap-2"
        >
          <button
            type="button"
            className="justify-self-start rounded-sm border border-border bg-surface-sunken px-3 py-1.5 text-sm font-semibold text-ink"
          >
            Tab to me
          </button>
          <p className="text-sm text-ink-muted">
            Select this sentence to see <code>::selection</code>, which is{" "}
            <code>--jts-color-highlight</code> over{" "}
            <code>--jts-color-highlight-text</code>.
          </p>
        </Specimen>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STATUS_SPECIMENS.map((status) => (
          <div
            key={status.tone}
            className="grid content-start gap-2 rounded-md border border-border bg-surface p-4"
          >
            <p className={clsx("jts-overline", status.fg)}>{status.tone}</p>
            <p className="text-xs text-ink-muted">{status.meaning}</p>
            <p
              className={clsx(
                "rounded-sm border px-2 py-1 text-xs font-semibold",
                status.soft,
              )}
            >
              soft + border
            </p>
            <p
              className={clsx(
                "rounded-sm px-2 py-1 text-xs font-semibold",
                status.solid,
              )}
            >
              solid on canvas
            </p>
            <ul className="grid gap-0.5">
              {status.tokens.map((token) => (
                <li
                  key={token}
                  className="truncate font-mono text-[length:var(--jts-text-2xs)] text-ink-subtle"
                >
                  {token}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function SwatchGrid({ swatches }: { swatches: readonly Swatch[] }) {
  return (
    <ul className="grid w-full gap-2 sm:grid-cols-2">
      {swatches.map((swatch) => (
        <li key={swatch.utility} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={clsx(
              "size-8 shrink-0 rounded-sm border border-border",
              swatch.chip,
            )}
          />
          <span className="grid min-w-0">
            <code className="truncate font-mono text-xs text-ink">
              {swatch.utility}
            </code>
            <code className="truncate font-mono text-[length:var(--jts-text-2xs)] text-ink-subtle">
              {swatch.token}
            </code>
          </span>
        </li>
      ))}
    </ul>
  );
}

function InkList({
  specimens,
  mutedTone,
}: {
  specimens: readonly InkSpecimen[];
  /** Tone for the token line, which differs on the inverse surface. */
  mutedTone: string;
}) {
  return (
    <ul className="grid w-full gap-2">
      {specimens.map((specimen) => (
        <li key={specimen.utility} className="grid min-w-0">
          <span className={clsx("text-sm font-semibold", specimen.text)}>
            Δείπνο στο Κολωνάκι · Foundation dinner
          </span>
          <code className={clsx("truncate font-mono text-xs", mutedTone)}>
            {specimen.utility} → {specimen.token}
          </code>
        </li>
      ))}
    </ul>
  );
}

interface Swatch {
  /** The bridge utility a component writes. Every one of these is literal, so
   *  Tailwind's scanner emits the rule — never build these by interpolation. */
  utility: string;
  /** The `--jts-*` token that utility resolves to. */
  token: string;
  /** Applied to the chip, so the chip is painted by the utility it names. */
  chip: string;
}

const SURFACE_SWATCHES: readonly Swatch[] = [
  { utility: "bg-canvas", token: "--jts-color-canvas", chip: "bg-canvas" },
  { utility: "bg-surface", token: "--jts-color-surface", chip: "bg-surface" },
  {
    utility: "bg-surface-raised",
    token: "--jts-color-surface-raised",
    chip: "bg-surface-raised",
  },
  {
    utility: "bg-surface-sunken",
    token: "--jts-color-surface-sunken",
    chip: "bg-surface-sunken",
  },
  {
    utility: "bg-overlay",
    token: "--jts-color-surface-overlay",
    chip: "bg-overlay",
  },
  {
    utility: "bg-surface-strong",
    token: "--jts-color-surface-strong",
    chip: "bg-surface-strong",
  },
];

const BORDER_SWATCHES: readonly Swatch[] = [
  {
    utility: "border-border-subtle",
    token: "--jts-color-border-subtle",
    chip: "border-2 border-border-subtle",
  },
  {
    utility: "border-border",
    token: "--jts-color-border",
    chip: "border-2 border-border",
  },
  {
    utility: "border-border-strong",
    token: "--jts-color-border-strong",
    chip: "border-2 border-border-strong",
  },
  {
    utility: "border-primary-border",
    token: "--jts-color-primary-border",
    chip: "border-2 border-primary-border",
  },
];

const BRAND_SWATCHES: readonly Swatch[] = [
  { utility: "bg-primary", token: "--jts-color-primary", chip: "bg-primary" },
  {
    utility: "bg-primary-hover",
    token: "--jts-color-primary-hover",
    chip: "bg-primary-hover",
  },
  {
    utility: "bg-primary-active",
    token: "--jts-color-primary-active",
    chip: "bg-primary-active",
  },
  {
    utility: "bg-primary-soft",
    token: "--jts-color-primary-soft",
    chip: "bg-primary-soft",
  },
];

const ACCENT_SWATCHES: readonly Swatch[] = [
  { utility: "bg-copper", token: "--jts-color-accent", chip: "bg-copper" },
  {
    utility: "bg-copper-soft",
    token: "--jts-color-accent-soft",
    chip: "bg-copper-soft",
  },
  { utility: "bg-link", token: "--jts-color-link", chip: "bg-link" },
  { utility: "bg-focus", token: "--jts-color-focus", chip: "bg-focus" },
  {
    utility: "bg-highlight",
    token: "--jts-color-highlight",
    chip: "bg-highlight",
  },
  {
    utility: "bg-highlight-text",
    token: "--jts-color-highlight-text",
    chip: "bg-highlight-text",
  },
];

const SIDEBAR_SWATCHES: readonly Swatch[] = [
  {
    utility: "bg-sidebar",
    token: "--jts-color-sidebar-bg",
    chip: "bg-sidebar",
  },
  {
    utility: "bg-sidebar-hover",
    token: "--jts-color-sidebar-hover-bg",
    chip: "bg-sidebar-hover",
  },
  {
    utility: "bg-sidebar-active",
    token: "--jts-color-sidebar-active-bg",
    chip: "bg-sidebar-active",
  },
  {
    utility: "bg-sidebar-accent",
    token: "--jts-color-sidebar-accent",
    chip: "bg-sidebar-accent",
  },
];

interface InkSpecimen {
  utility: string;
  token: string;
  /** The text tone itself — the only honest way to audit an ink token. */
  text: string;
}

const INK_SPECIMENS: readonly InkSpecimen[] = [
  { utility: "text-ink", token: "--jts-color-text", text: "text-ink" },
  {
    utility: "text-ink-muted",
    token: "--jts-color-text-muted",
    text: "text-ink-muted",
  },
  {
    utility: "text-ink-subtle",
    token: "--jts-color-text-subtle",
    text: "text-ink-subtle",
  },
];

const ON_STRONG_SPECIMENS: readonly InkSpecimen[] = [
  {
    utility: "text-on-strong",
    token: "--jts-color-text-on-strong",
    text: "text-on-strong",
  },
  {
    utility: "text-on-strong-muted",
    token: "--jts-color-text-on-strong-muted",
    text: "text-on-strong-muted",
  },
];

interface StatusSpecimen {
  tone: string;
  meaning: string;
  /** fg / soft+border / solid — the three shapes a status is ever used in. */
  fg: string;
  soft: string;
  solid: string;
  tokens: readonly string[];
}

const STATUS_SPECIMENS: readonly StatusSpecimen[] = [
  {
    tone: "Success",
    meaning: "Delivered, cleared, nothing to do",
    fg: "text-success",
    soft: "border-success-border bg-success-soft text-success",
    solid: "bg-success text-canvas",
    tokens: [
      "--jts-color-success",
      "--jts-color-success-soft",
      "--jts-color-success-border",
    ],
  },
  {
    tone: "Warning",
    meaning: "Waiting too long, needs a look",
    fg: "text-warning",
    soft: "border-warning-border bg-warning-soft text-warning",
    solid: "bg-warning text-canvas",
    tokens: [
      "--jts-color-warning",
      "--jts-color-warning-soft",
      "--jts-color-warning-border",
    ],
  },
  {
    tone: "Danger",
    meaning: "Failed, blocked, or needs a person now",
    fg: "text-danger",
    soft: "border-danger-border bg-danger-soft text-danger",
    solid: "bg-danger text-canvas",
    tokens: [
      "--jts-color-danger",
      "--jts-color-danger-soft",
      "--jts-color-danger-border",
    ],
  },
  {
    tone: "Info",
    meaning: "Open, in progress, stated for the record",
    fg: "text-info",
    soft: "border-info-border bg-info-soft text-info",
    solid: "bg-info text-canvas",
    tokens: [
      "--jts-color-info",
      "--jts-color-info-soft",
      "--jts-color-info-border",
    ],
  },
  {
    tone: "Rose",
    meaning: "Gossip tea tint — decorative, not a badge tone",
    fg: "text-rose",
    soft: "border-rose-border bg-rose-soft text-rose",
    solid: "bg-rose text-canvas",
    tokens: [
      "--jts-color-rose",
      "--jts-color-rose-soft",
      "--jts-color-rose-border",
    ],
  },
];
