import { Bell, Check, Shield, TriangleAlert } from "lucide-react";

import { CopyableId } from "../../components/admin/feedback/CopyableId";
import {
  FeedbackBadges,
  type FeedbackBadgeWithIcon,
} from "../../components/admin/feedback/FeedbackBadges";
import {
  ConfidenceValue,
  FACT_PILL,
  TimestampPill,
} from "../../components/admin/feedback/OutboxMessageDetails";
import { ProviderMark } from "../../components/admin/feedback/ProviderMark";

import { FEEDBACK_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";

export function FeedbackSection() {
  return (
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
  );
}

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
  (badge) => ({
    ...badge,
    key: `${badge.key}-strong`,
    emphasis: "strong",
  }),
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
