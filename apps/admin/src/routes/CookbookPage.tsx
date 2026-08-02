import { useState, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Chip,
  Drawer,
  ErrorMessage,
  Input,
  Label,
  ListBox,
  Modal,
  Pagination,
  Popover,
  ScrollShadow,
  Select,
  Slider,
  Table,
  TextArea,
  TextField,
  ToggleButton,
  toast,
} from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import { clsx } from "clsx";
import {
  Bell,
  Boxes,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Component,
  type LucideIcon,
  MessagesSquare,
  Palette,
  Ruler,
  Shield,
  SunMoon,
  TriangleAlert,
  Type,
  Users,
} from "lucide-react";

import { BrandLockup } from "../components/admin/BrandLockup";
import { CopyableId } from "../components/admin/feedback/CopyableId";
import {
  FeedbackBadges,
  type FeedbackBadgeWithIcon,
} from "../components/admin/feedback/FeedbackBadges";
import {
  ConfidenceValue,
  FACT_PILL,
  TimestampPill,
} from "../components/admin/feedback/OutboxMessageDetails";
import { ProviderMark } from "../components/admin/feedback/ProviderMark";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsLiveIndicator } from "../components/ui/JtsLiveIndicator";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { JtsStat } from "../components/ui/JtsStat";
import { usePageMeta } from "../lib/usePageMeta";

/* -----------------------------------------------------------------------------
   Section spine — the table of contents and the headings read from one list, so
   an anchor can never point at a section that was renamed or removed.
   ----------------------------------------------------------------------------- */

interface SectionSpec {
  id: string;
  title: string;
  Icon: LucideIcon;
  /** The one-line reason this section is on the page. */
  lede: string;
}

const COLOUR_SECTION: SectionSpec = {
  id: "colour",
  title: "Colour tokens",
  Icon: Palette,
  lede: "Every semantic colour the bridge exposes, painted by the utility a component would actually write.",
};

const TYPE_SECTION: SectionSpec = {
  id: "type",
  title: "Typography",
  Icon: Type,
  lede: "Manrope for UI/body, Commissioner for display — both Latin and Greek — plus the scale, weights and numerals built on them.",
};

const HEROUI_SECTION: SectionSpec = {
  id: "heroui",
  title: "HeroUI components",
  Icon: Component,
  lede: "Live components, not pictures of them. A bridge edit repaints this section in place.",
};

const JTS_SECTION: SectionSpec = {
  id: "jts",
  title: "Jts components",
  Icon: Boxes,
  lede: "The shared operational contracts every screen composes from.",
};

const FEEDBACK_SECTION: SectionSpec = {
  id: "feedback",
  title: "Feedback vocabulary",
  Icon: MessagesSquare,
  lede: "The status pills, ids and machine values the feedback screens speak in.",
};

const MOTIF_SECTION: SectionSpec = {
  id: "motifs",
  title: "Motifs & rules",
  Icon: Ruler,
  lede: "The sanctioned emphasis devices, and the invariants that keep them the only ones.",
};

/** Reading order. The table of contents and the section numerals both read it. */
const SECTIONS: readonly SectionSpec[] = [
  COLOUR_SECTION,
  TYPE_SECTION,
  HEROUI_SECTION,
  JTS_SECTION,
  FEEDBACK_SECTION,
  MOTIF_SECTION,
];

/* -----------------------------------------------------------------------------
   Frames. Two of them, deliberately: a section and a labelled specimen. A
   gallery that grows a third frame starts competing with the vocabulary it is
   supposed to display.
   ----------------------------------------------------------------------------- */

function Section({
  spec,
  children,
}: {
  spec: SectionSpec;
  children: ReactNode;
}) {
  const { Icon } = spec;
  // The numeral is the section's place in the reading order, read from the one
  // list, so a reorder can never leave a heading claiming a position it lost.
  const numeral = String(SECTIONS.indexOf(spec) + 1).padStart(2, "0");

  return (
    // `scroll-mt` clears the small-screen sticky header, which would otherwise
    // land every anchor jump underneath it.
    <section
      id={spec.id}
      aria-labelledby={`${spec.id}-heading`}
      className="grid scroll-mt-24 gap-3"
    >
      <div className="border-b border-border pb-2">
        <p className="jts-overline text-ink-subtle">{numeral} · Cookbook</p>
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

function Specimen({
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

/* -----------------------------------------------------------------------------
   1. Colour.
   ----------------------------------------------------------------------------- */

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
    utility: "bg-sidebar-active-index",
    token: "--jts-color-sidebar-active-index",
    chip: "bg-sidebar-active-index",
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
];

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

/* -----------------------------------------------------------------------------
   2. Typography.
   ----------------------------------------------------------------------------- */

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
    sample: "Join The Six",
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

/* -----------------------------------------------------------------------------
   3. Sample data. Static, obviously invented, and in the product's own voice —
   the page has to render with the backend down, so nothing here is fetched.
   ----------------------------------------------------------------------------- */

interface DinnerRow {
  id: string;
  event: string;
  host: string;
  seats: string;
  badge: FeedbackBadgeWithIcon;
}

const DINNER_ROWS: readonly DinnerRow[] = [
  {
    id: "row-kolonaki",
    event: "Δείπνο στο Κολωνάκι",
    host: "Ελένη Παπαδοπούλου",
    seats: "6 / 6",
    badge: { key: "ready", label: "Ready", tone: "success" },
  },
  {
    id: "row-pagkrati",
    event: "Πέμπτη στο Παγκράτι",
    host: "Νίκος Αντωνίου",
    seats: "4 / 6",
    badge: { key: "open", label: "Open", tone: "info" },
  },
  {
    id: "row-thessaloniki",
    event: "Δείπνο στη Θεσσαλονίκη",
    host: "Θανάσης Κυριακίδης",
    seats: "5 / 6",
    badge: { key: "waiting", label: "Needs venue", tone: "warning" },
  },
  {
    id: "row-kyriaki",
    event: "Κυριακάτικο τραπέζι",
    host: "Μαρία Βλάχου",
    seats: "0 / 6",
    badge: { key: "draft", label: "Draft", tone: "neutral" },
  },
];

const DINNER_COLUMNS: ColumnDef<DinnerRow>[] = [
  {
    accessorKey: "event",
    header: "Event",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <strong className="font-bold text-ink">{row.original.event}</strong>
        <small className="text-xs text-ink-muted">{row.original.host}</small>
      </div>
    ),
  },
  {
    accessorKey: "seats",
    header: "Seats",
    meta: { align: "end" },
  },
  {
    accessorKey: "badge",
    header: "Stage",
    enableSorting: false,
    cell: ({ row }) => <FeedbackBadges badges={[row.original.badge]} />,
  },
];

const QUEUE_SAMPLE: readonly {
  id: string;
  who: string;
  event: string;
  waiting: string;
}[] = [
  {
    id: "queue-1",
    who: "Ελένη Παπαδοπούλου",
    event: "Δείπνο στο Κολωνάκι",
    waiting: "2m 14s",
  },
  {
    id: "queue-2",
    who: "Νίκος Αντωνίου",
    event: "Πέμπτη στο Παγκράτι",
    waiting: "47s",
  },
  {
    id: "queue-3",
    who: "άγνωστος συμμετέχων",
    event: "Κυριακάτικο τραπέζι",
    waiting: "11m 03s",
  },
];

const PARTICIPANT_SAMPLE: readonly string[] = [
  "Ελένη Παπαδοπούλου",
  "Νίκος Αντωνίου",
  "Μαρία Βλάχου",
  "Θανάσης Κυριακίδης",
  "Δήμητρα Σωτηρίου",
  "Αλέξανδρος Ρέππας",
  "Ιωάννα Μανωλάκη",
];

/** All six tones, so a new tone that forgets its pairing shows up here first. */
const TONE_SAMPLE: readonly FeedbackBadgeWithIcon[] = [
  { key: "neutral", label: "Draft", tone: "neutral" },
  { key: "info", label: "Open", tone: "info" },
  { key: "success", label: "Delivered", tone: "success" },
  { key: "warning", label: "Waiting", tone: "warning" },
  { key: "danger", label: "Needs a person", tone: "danger" },
  { key: "accent", label: "Human control", tone: "accent" },
];

const TONE_SAMPLE_STRONG: readonly FeedbackBadgeWithIcon[] = TONE_SAMPLE.map(
  (badge) => ({ ...badge, key: `${badge.key}-strong`, emphasis: "strong" }),
);

const TONE_SAMPLE_GLYPHS: readonly FeedbackBadgeWithIcon[] = [
  { key: "glyph-success", label: "Delivered", tone: "success", glyph: Check },
  {
    key: "glyph-warning",
    label: "Waiting",
    tone: "warning",
    glyph: TriangleAlert,
  },
  {
    key: "glyph-danger",
    label: "Needs a person",
    tone: "danger",
    glyph: Shield,
  },
  { key: "glyph-info", label: "Reminder due", tone: "info", glyph: Bell },
];

/* -----------------------------------------------------------------------------
   4. Motifs and non-colour scales.
   ----------------------------------------------------------------------------- */

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

/* =============================================================================
   The page.
   ============================================================================= */

/**
 * The cookbook: every visual building block the panel owns, on one screen.
 *
 * It exists so that a change to `tokens.css` or to the HeroUI bridge in
 * `globals.css` can be judged in one place instead of by touring the real
 * screens and hoping the tour covered the affected component. Everything here
 * is a live component — a swatch is painted by the utility it names, and the
 * HeroUI specimens are the same components the product uses — so a repaint is
 * visible rather than described.
 *
 * It is development-only. `App.tsx` and `AdminNavigation.tsx` gate the route and
 * the nav row on `import.meta.env.DEV`, which Vite folds to `false` in a
 * production build, so this module is never reached and never bundled.
 *
 * Nothing here fetches: the page must render with the backend down, because the
 * moment somebody wants to check a token is not the moment to require a
 * database. Sample content is invented and in the product's own voice.
 */
export function CookbookPage() {
  usePageMeta(
    "Cookbook",
    "Development-only gallery of the admin panel's visual vocabulary.",
  );

  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState(2);
  const [isSpinning, setSpinning] = useState(false);
  // Controlled, like every field the product ships: HeroUI's TextField feeds
  // its own `value` to the DOM element through react-aria context, so an
  // uncontrolled `defaultValue` child renders with both props and React
  // reports the conflict on every mount.
  const [eventName, setEventName] = useState("Δείπνο στο Κολωνάκι");
  const [venueAddress, setVenueAddress] = useState("");
  const [operatorNote, setOperatorNote] = useState(
    "Η Ελένη ζήτησε τραπέζι κοντά στο παράθυρο.",
  );

  return (
    <div className="grid gap-8">
      <JtsPageHeader
        eyebrow="Development instrument"
        title="Cookbook"
        description="Every colour, type step, HeroUI primitive and project component the admin panel is built from, on one page. Change a token and watch what moves."
      />

      <div
        role="note"
        className="flex items-start gap-3 rounded-md border border-copper/35 bg-copper-soft px-4 py-3 text-sm text-ink-muted"
      >
        <SunMoon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-copper"
        />
        <span>
          To audit dark mode, flip{" "}
          <strong className="text-ink">Appearance</strong> in the operator menu
          (sidebar footer) and read this page again; to audit a palette, pick a{" "}
          <strong className="text-ink">Theme</strong> in the same menu — every
          specimen on this page repaints with it. There is no side-by-side
          preview on purpose: the <code>dark</code> class on{" "}
          <code>&lt;html&gt;</code> is the only dark-mode signal, and a faked
          second theme would be the one thing on this page that cannot be
          trusted.
        </span>
      </div>

      <nav aria-label="Cookbook sections">
        <ul className="flex flex-wrap gap-2">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1 text-xs font-semibold text-ink no-underline transition-colors hover:border-primary-border hover:text-primary"
              >
                <section.Icon aria-hidden="true" className="size-3.5" />
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* 01 — Colour ---------------------------------------------------------- */}
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
              The wine sidebar is wine in both themes, so these two carry no
              dark override.
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

      {/* 02 — Typography ------------------------------------------------------ */}
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

          <Specimen
            label="Tracking & the overline recipe"
            className="grid gap-2"
          >
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

      {/* 03 — HeroUI ---------------------------------------------------------- */}
      <Section spec={HEROUI_SECTION}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Specimen label="Buttons — variants">
            <Button variant="primary">Launch campaign</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="tertiary">Tertiary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Close campaign</Button>
            <Button variant="danger-soft">Danger soft</Button>
            <Button isDisabled>Disabled</Button>
          </Specimen>

          <Specimen
            label="Buttons — sizes & icon-only"
            note="An icon-only control always carries an aria-label; the glyph itself is aria-hidden."
          >
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button isIconOnly aria-label="Next page" variant="outline">
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
            <Button isIconOnly aria-label="Confirm" variant="ghost" isDisabled>
              <Check aria-hidden="true" className="size-4" />
            </Button>
          </Specimen>

          <Specimen label="Chips — colours (soft)">
            <Chip variant="soft">Default</Chip>
            <Chip variant="soft" color="accent">
              Accent
            </Chip>
            <Chip variant="soft" color="success">
              Success
            </Chip>
            <Chip variant="soft" color="warning">
              Warning
            </Chip>
            <Chip variant="soft" color="danger">
              Danger
            </Chip>
          </Specimen>

          <Specimen
            label="Chips — variants & sizes"
            note="HeroUI's chip has no slate `info` slot, which is why the feedback screens carry their own badge instead."
          >
            <Chip variant="primary" color="accent">
              Primary
            </Chip>
            <Chip variant="secondary" color="accent">
              Secondary
            </Chip>
            <Chip variant="tertiary" color="accent">
              Tertiary
            </Chip>
            <Chip variant="soft" color="accent" size="sm">
              Small
            </Chip>
            <Chip variant="soft" color="accent" size="lg">
              Large
            </Chip>
          </Specimen>

          <Specimen label="Text fields" className="grid gap-4">
            <TextField fullWidth>
              <Label className="text-sm font-semibold text-ink">
                Event name
              </Label>
              <Input
                value={eventName}
                onChange={(change) => setEventName(change.target.value)}
                autoComplete="off"
                className="w-full"
              />
            </TextField>
            <TextField fullWidth isInvalid>
              <Label className="text-sm font-semibold text-ink">
                Venue address
              </Label>
              <Input
                value={venueAddress}
                onChange={(change) => setVenueAddress(change.target.value)}
                autoComplete="off"
                className="w-full"
              />
              <ErrorMessage className="mt-1.5">
                A venue is required before the dinner can leave draft.
              </ErrorMessage>
            </TextField>
            <TextField fullWidth>
              <Label className="text-sm font-semibold text-ink">
                Operator note
              </Label>
              <TextArea
                rows={3}
                value={operatorNote}
                onChange={(change) => setOperatorNote(change.target.value)}
                className="w-full"
              />
            </TextField>
          </Specimen>

          <Specimen label="Choice controls" className="grid gap-4">
            <div className="grid gap-1.5">
              <span className="jts-overline text-ink-muted">Campaign</span>
              <Select aria-label="Campaign" defaultSelectedKey="kolonaki">
                <Select.Trigger className="w-full">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="kolonaki" textValue="Δείπνο στο Κολωνάκι">
                      Δείπνο στο Κολωνάκι
                    </ListBox.Item>
                    <ListBox.Item id="pagkrati" textValue="Πέμπτη στο Παγκράτι">
                      Πέμπτη στο Παγκράτι
                    </ListBox.Item>
                    <ListBox.Item id="kyriaki" textValue="Κυριακάτικο τραπέζι">
                      Κυριακάτικο τραπέζι
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <span className="jts-overline text-ink-muted">
                Event score correction
              </span>
              <Slider
                aria-label="Event score"
                minValue={1}
                maxValue={6}
                step={1}
                defaultValue={4}
                className="w-48"
              >
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
            </div>
            <div className="grid gap-1.5">
              <span className="jts-overline text-ink-muted">Toggle button</span>
              <ToggleButton
                className="w-fit rounded-md"
                defaultSelected
                aria-label="Only conversations needing attention"
              >
                Needs attention
              </ToggleButton>
            </div>
          </Specimen>

          <Specimen
            label="Overlays"
            note="Each one opens for real — a bridge edit to --overlay, --backdrop or --overlay-shadow shows up only when the thing is open."
          >
            <Popover>
              <Button variant="outline">Open popover</Button>
              <Popover.Content placement="bottom">
                <Popover.Dialog
                  aria-label="Popover specimen"
                  className="grid max-w-[18rem] gap-1"
                >
                  <p className="jts-overline text-ink-muted">Popover surface</p>
                  <p className="text-sm text-ink-muted">
                    Positioned surface on{" "}
                    <code>--jts-color-surface-overlay</code> with{" "}
                    <code>--jts-shadow-md</code>.
                  </p>
                </Popover.Dialog>
              </Popover.Content>
            </Popover>

            <Modal>
              <Button variant="outline">Open modal</Button>
              <Modal.Backdrop>
                <Modal.Container size="sm" placement="center">
                  <Modal.Dialog>
                    <Modal.Header className="flex items-start justify-between gap-4">
                      <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                        Modal specimen
                      </Modal.Heading>
                      <Modal.CloseTrigger />
                    </Modal.Header>
                    <Modal.Body>
                      <p className="text-sm text-ink-muted">
                        The backdrop, the container radius and the dialog
                        surface all come from the bridge. Nothing here is real —
                        no dinner was created.
                      </p>
                    </Modal.Body>
                    <Modal.Footer className="flex justify-end gap-3">
                      <Button variant="ghost">Cancel</Button>
                      <Button>Confirm</Button>
                    </Modal.Footer>
                  </Modal.Dialog>
                </Modal.Container>
              </Modal.Backdrop>
            </Modal>

            <Drawer isOpen={isDrawerOpen} onOpenChange={setDrawerOpen}>
              <Button variant="outline">Open drawer</Button>
              <Drawer.Backdrop>
                <Drawer.Content placement="right">
                  <Drawer.Dialog>
                    <Drawer.Header className="flex items-center justify-between gap-3">
                      <Drawer.Heading className="font-display text-[1.15rem] font-extrabold tracking-tight text-ink">
                        Drawer specimen
                      </Drawer.Heading>
                      <Drawer.CloseTrigger />
                    </Drawer.Header>
                    <Drawer.Body>
                      <p className="text-sm text-ink-muted">
                        The same surface the small-screen navigation uses,
                        opened from the right so it does not read as the nav.
                      </p>
                    </Drawer.Body>
                  </Drawer.Dialog>
                </Drawer.Content>
              </Drawer.Backdrop>
            </Drawer>

            <Button
              variant="outline"
              onPress={() =>
                toast.success("Specimen toast", {
                  description:
                    "Fired from the cookbook. Nothing was sent to anyone.",
                })
              }
            >
              Fire a toast
            </Button>
          </Specimen>

          <Specimen
            label="Avatars"
            note="Rounded square: the circle stays reserved for the brand mark."
          >
            <Avatar
              color="accent"
              variant="soft"
              size="sm"
              className="rounded-md"
            >
              <Avatar.Fallback>ΕΠ</Avatar.Fallback>
            </Avatar>
            <Avatar
              color="accent"
              variant="soft"
              size="md"
              className="rounded-md"
            >
              <Avatar.Fallback>ΝΑ</Avatar.Fallback>
            </Avatar>
            <Avatar
              color="success"
              variant="soft"
              size="lg"
              className="rounded-md"
            >
              <Avatar.Fallback>ΜΒ</Avatar.Fallback>
            </Avatar>
            <Avatar
              color="danger"
              variant="soft"
              size="lg"
              className="rounded-md"
            >
              <Avatar.Fallback>ΘΚ</Avatar.Fallback>
            </Avatar>
          </Specimen>

          <Specimen label="List box" className="grid gap-2">
            <ListBox
              aria-label="Participants"
              selectionMode="single"
              defaultSelectedKeys={["Μαρία Βλάχου"]}
              className="max-h-40"
            >
              {PARTICIPANT_SAMPLE.slice(0, 4).map((name) => (
                <ListBox.Item key={name} id={name} textValue={name}>
                  {name}
                </ListBox.Item>
              ))}
            </ListBox>
          </Specimen>

          <Specimen
            label="Scroll shadow"
            note="Keyboard-reachable on purpose: a scrollable region nobody can tab into is a region some operators cannot read."
            className="grid gap-2"
          >
            <ScrollShadow
              role="region"
              aria-label="Participant sample"
              tabIndex={0}
              orientation="vertical"
              className="max-h-28 w-full overflow-y-auto rounded-sm border border-border bg-surface-sunken p-2 focus-visible:-outline-offset-2"
            >
              <ul className="grid gap-1">
                {PARTICIPANT_SAMPLE.map((name) => (
                  <li key={name} className="text-sm text-ink">
                    {name}
                  </li>
                ))}
              </ul>
            </ScrollShadow>
          </Specimen>

          <Specimen label="Pagination" className="grid gap-2">
            <Pagination aria-label="Specimen pagination">
              <Pagination.Content className="flex items-center gap-1">
                <Pagination.Item>
                  <Pagination.Previous
                    aria-label="Previous page"
                    isDisabled={page === 1}
                    onPress={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                  >
                    <ChevronLeft aria-hidden="true" className="size-4" />
                  </Pagination.Previous>
                </Pagination.Item>
                {[1, 2, 3].map((item) => (
                  <Pagination.Item key={item}>
                    <Pagination.Link
                      isActive={item === page}
                      aria-label={`Page ${item}`}
                      onPress={() => setPage(item)}
                    >
                      {item}
                    </Pagination.Link>
                  </Pagination.Item>
                ))}
                <Pagination.Item>
                  <Pagination.Ellipsis />
                </Pagination.Item>
                <Pagination.Item>
                  <Pagination.Next
                    aria-label="Next page"
                    isDisabled={page === 3}
                    onPress={() =>
                      setPage((current) => Math.min(3, current + 1))
                    }
                  >
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </Pagination.Next>
                </Pagination.Item>
              </Pagination.Content>
            </Pagination>
          </Specimen>

          <Specimen
            label="Table"
            note="The bare HeroUI table. JtsDataTable below is this plus naming, states, overflow and pagination."
            className="grid"
          >
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Outbound queue specimen">
                  <Table.Header>
                    <Table.Column id="who" isRowHeader>
                      Participant
                    </Table.Column>
                    <Table.Column id="event">Event</Table.Column>
                    <Table.Column id="waiting">Waiting</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {QUEUE_SAMPLE.map((row) => (
                      <Table.Row key={row.id} id={row.id}>
                        <Table.Cell>{row.who}</Table.Cell>
                        <Table.Cell>{row.event}</Table.Cell>
                        <Table.Cell className="tabular-nums">
                          {row.waiting}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </Specimen>
        </div>
      </Section>

      {/* 04 — Jts components -------------------------------------------------- */}
      <Section spec={JTS_SECTION}>
        <div className="grid gap-2 rounded-md border border-border border-dashed bg-surface p-4">
          <p className="jts-overline text-ink-muted">
            JtsPageHeader — specimen frame
          </p>
          <p className="text-xs text-ink-subtle">
            The real one is at the top of this page. The copy below is a
            specimen: it is hidden from assistive technology, because
            JtsPageHeader renders an h1 and a page has exactly one. It holds no
            focusable control, so hiding it costs nobody anything.
          </p>
          {/* aria-hidden rather than a fake heading level: the point of the
              specimen is that it is the real component, unaltered. */}
          <div aria-hidden="true" className="rounded-sm bg-surface-sunken p-4">
            <JtsPageHeader
              eyebrow="Feedback & safety"
              title="Δείπνο στο Κολωνάκι"
              description="Eyebrow, the h1 with its 3px marker, and a muted supporting line. Actions are omitted here — a hidden frame must not contain anything focusable."
            />
          </div>
        </div>

        <dl aria-label="JtsStat tones" className="grid gap-3 sm:grid-cols-3">
          <JtsStat
            label="Conversations"
            value={128}
            detail="Across every launched campaign"
            icon={Users}
          />
          <JtsStat
            label="Answered"
            value={94}
            detail="Every question closed"
            tone="success"
            icon={CircleCheck}
          />
          <JtsStat
            label="Waiting too long"
            value={7}
            detail="Older than ten minutes"
            tone="warning"
            icon={TriangleAlert}
          />
        </dl>

        <JtsDataTable
          rows={DINNER_ROWS}
          columns={DINNER_COLUMNS}
          getRowId={(row) => row.id}
          title="JtsDataTable"
          description="Sortable headers, a toolbar slot, zebra rows and the client paginator. Sample rows only — nothing here was fetched."
          paginator
          pageSize={3}
          rowsPerPageOptions={[3, 10, 25]}
          toolbarEnd={
            <Button variant="outline" size="sm">
              <Calendar aria-hidden="true" className="size-4" />
              Toolbar slot
            </Button>
          }
        />

        <Specimen
          label="JtsLiveIndicator"
          note="It occupies its space whether or not it is turning, so a poll never nudges the header beside it. It never changes colour — «working» is not a status anyone must act on."
        >
          <ToggleButton
            className="rounded-md"
            isSelected={isSpinning}
            onChange={setSpinning}
          >
            {isSpinning ? "Stop the fetch" : "Simulate a fetch"}
          </ToggleButton>
          <JtsLiveIndicator
            active={isSpinning}
            label="This specimen refreshes itself every few seconds."
          />
        </Specimen>
      </Section>

      {/* 05 — Feedback vocabulary --------------------------------------------- */}
      <Section spec={FEEDBACK_SECTION}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Specimen
            label="Badges — six tones, soft"
            note="Six because HeroUI's chip has five and no slate: «Open» and «Cancelled» looked identical until this existed."
          >
            <FeedbackBadges badges={TONE_SAMPLE} size="md" />
          </Specimen>

          <Specimen
            label="Badges — strong"
            note="For the one badge an operator must not skim past. Every fill pairs with canvas, which is what keeps it AA in both themes."
          >
            <FeedbackBadges badges={TONE_SAMPLE_STRONG} size="md" />
          </Specimen>

          <Specimen label="Badges — small (the row default)">
            <FeedbackBadges badges={TONE_SAMPLE} size="sm" />
          </Specimen>

          <Specimen
            label="Badges — with glyphs"
            note="The glyph is decoration; the label carries the meaning, so tone is never the only signal."
          >
            <FeedbackBadges badges={TONE_SAMPLE_GLYPHS} size="md" />
          </Specimen>

          <Specimen
            label="CopyableId"
            note="Live — click one. Truncated to eight characters, full value on hover, and the confirmation is a glyph swap in the same box so the row never moves."
          >
            <CopyableId
              value="c8f4a1d2-77e1-4b90-9a03-1f6b2c5d8e40"
              label="correlation id"
            />
            <CopyableId value="outbox-91" label="outbox id" />
          </Specimen>

          <Specimen
            label="ProviderMark & model pills"
            note="Only OpenAI is drawn. Anything routed through OpenRouter takes lucide's neutral Sparkles — a logo redrawn on somebody else's behalf is a claim the record does not support."
          >
            <span className={FACT_PILL}>
              <ProviderMark
                provider="openai"
                className="size-3.5 shrink-0 text-ink-muted"
              />
              <span className="min-w-0 break-all">gpt-5.1-mini</span>
            </span>
            <span className={FACT_PILL}>
              <ProviderMark
                provider="generic"
                className="size-3.5 shrink-0 text-ink-muted"
              />
              <span className="min-w-0 break-all">qwen/qwen3-max</span>
            </span>
          </Specimen>

          <Specimen
            label="Timestamps & confidence"
            note="Imported from OutboxMessageDetails rather than re-drawn here — a cookbook that drifts from the real component is worse than none."
            className="grid gap-2"
          >
            <TimestampPill text="2026-08-01 21:14:42.318" />
            <span className="text-sm text-ink">
              <ConfidenceValue text="82% confident" ratio={0.82} />
            </span>
            <span className="text-sm text-ink">
              <ConfidenceValue text="not reported" ratio={null} />
            </span>
          </Specimen>
        </div>
      </Section>

      {/* 06 — Motifs & rules -------------------------------------------------- */}
      <Section spec={MOTIF_SECTION}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Specimen
            label="The 3px marker — horizontal"
            note="Under a page title. It means «this matters», never «you are here»."
            className="grid gap-2"
          >
            <p className="font-display text-[1.375rem] font-extrabold text-ink after:mt-2 after:block after:h-[3px] after:w-8 after:bg-primary after:content-['']">
              Operations control
            </p>
          </Specimen>

          <Specimen
            label="The 3px marker — vertical"
            note="On the left edge of a card, in wine or in a status tone. There is no third emphasis device."
            className="grid gap-2"
          >
            <p className="rounded-md border border-border border-l-[3px] border-l-primary bg-surface-sunken px-3 py-2 text-sm text-ink">
              border-l-[3px] border-l-primary
            </p>
            <p className="rounded-md border border-border border-l-[3px] border-l-warning bg-surface-sunken px-3 py-2 text-sm text-ink">
              border-l-[3px] border-l-warning
            </p>
          </Specimen>

          <Specimen
            label="Brand lockup"
            note="SVG mark (five people + empty chair) via currentColor + the Sora wordmark (`font-brand`, the wordmark's own face — never UI copy). With a tagline the mark steps up to 40px and both lines set solid, so the three parts read as one block."
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
    </div>
  );
}
