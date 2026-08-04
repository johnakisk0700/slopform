import { Button, toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Ban,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Drama,
  Handshake,
  Heart,
  ListTodo,
  Sparkles,
  UsersRound,
} from "lucide-react";

import { AssistantMarkdown } from "../assistant/AssistantMarkdown";
import {
  getGetFeedbackCampaignSummaryQueryKey,
  useGetFeedbackCampaignSummary,
  useRequestFeedbackCampaignSummary,
} from "../../../api/generated/feedback-campaigns";
import type { FeedbackCampaignSummaryDtoOutput } from "../../../api/generated/model/feedbackCampaignSummaryDtoOutput";
import type { FeedbackCampaignSummaryDtoOutputDocument } from "../../../api/generated/model/feedbackCampaignSummaryDtoOutputDocument";
import {
  campaignSummaryActionLabel,
  campaignSummaryPartialWarning,
  campaignSummaryPendingDetail,
  campaignSummaryPendingPhase,
  campaignSummaryStatusLabel,
  type CampaignSummaryPendingPhase,
} from "../../../features/feedback/campaignSummary";
import { formatExactTimestamp } from "../../../features/feedback/conversationView";
import { CAMPAIGN_SUMMARY_POLL_INTERVAL_MS } from "../../../features/feedback/polling";
import { apiErrorMessage } from "../../../lib/api";

interface CampaignSummaryProps {
  campaignId: string;
}

function statusToneClass(
  summary: Pick<FeedbackCampaignSummaryDtoOutput, "status" | "isPartial">,
  phase: CampaignSummaryPendingPhase | null,
): string {
  if (summary.status === "failed") {
    return "text-danger";
  }
  if (summary.status === "pending") {
    // A lapsed claim is not a failure — the row still self-heals — but it is
    // the state worth a second look, so it does not share the calm live tone.
    return phase === "retrying" ? "text-warning" : "text-info";
  }
  if (summary.status === "ready" && summary.isPartial) {
    return "text-warning";
  }
  if (summary.status === "ready") {
    return "text-success";
  }
  return "text-ink-muted";
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function metaParts(summary: FeedbackCampaignSummaryDtoOutput): string[] {
  const parts: string[] = [];
  if (summary.answerCount !== null) {
    parts.push(countLabel(summary.answerCount, "answer", "answers"));
  }
  if (summary.noteCount !== null) {
    parts.push(countLabel(summary.noteCount, "note", "notes"));
  }
  // The header carries how long the wait has been; a row that is still owed
  // also gets the exact clock it started from, which is what a worker log or an
  // audit entry is read against.
  if (summary.status === "pending" && summary.requestedAt !== null) {
    parts.push(`Requested ${formatExactTimestamp(summary.requestedAt)}`);
  }
  if (summary.generatedAt !== null) {
    parts.push(`Generated ${formatExactTimestamp(summary.generatedAt)}`);
  }
  return parts;
}

type SummaryDocument = NonNullable<FeedbackCampaignSummaryDtoOutputDocument>;
type SummaryScore = SummaryDocument["metrics"]["scores"][number];
type SummaryDirected = SummaryDocument["metrics"]["directed"][number];
type ScoredMetric = SummaryScore & { average: number };

const DIRECTED_METRIC_GLYPHS: Record<
  string,
  { icon: LucideIcon; className: string; chip: string }
> = {
  liked: {
    icon: Heart,
    className: "text-success",
    chip: "bg-success-soft",
  },
  meet_again: {
    icon: Handshake,
    className: "text-info",
    chip: "bg-info-soft",
  },
  avoid: {
    icon: Ban,
    className: "text-warning",
    chip: "bg-warning-soft",
  },
};

function directedPresentation(questionKey: string): {
  icon: LucideIcon;
  className: string;
  chip: string;
} {
  return (
    DIRECTED_METRIC_GLYPHS[questionKey] ?? {
      icon: UsersRound,
      className: "text-ink-subtle",
      chip: "bg-surface-sunken",
    }
  );
}

function SectionEmpty({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-2 text-sm text-ink-muted">
      <CircleDashed
        aria-hidden="true"
        strokeWidth={1.5}
        className="mt-0.5 size-4 shrink-0 text-ink-subtle"
      />
      {children}
    </p>
  );
}

/**
 * One report group inside the accordion. No nested border — the disclosure
 * already frames everything — but a soft sunken wash + padding so each block
 * has its own island without reading as a stack of cards.
 */
function ReportIsland({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-xl bg-surface-sunken px-4 py-4 sm:px-5 sm:py-5">
      <h3 className="flex items-center gap-2 jts-overline text-ink-muted">
        <Icon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-subtle"
        />
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One 1–max score as a report-card row: label, average, and a filled range
 * track so four dimensions compare by eye rather than by digit.
 */
function ScoreRangeRow({ score }: { score: ScoredMetric }) {
  const fillPercent = Math.min(
    100,
    Math.max(0, (score.average / score.max) * 100),
  );

  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm text-ink">{score.label}</span>
        <span className="shrink-0 font-display text-base font-extrabold tabular-nums text-ink">
          {score.average}
          <span className="text-sm font-semibold text-ink-subtle">
            {" "}
            / {score.max}
          </span>
        </span>
      </div>
      <div
        aria-hidden="true"
        className="h-2.5 overflow-hidden rounded-full bg-surface ring-1 ring-inset ring-border-subtle"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${fillPercent}%` }}
        />
      </div>
      <p className="text-xs text-ink-subtle">
        {countLabel(score.answerCount, "answer", "answers")}
      </p>
    </li>
  );
}

/**
 * Person-valued tallies (meet again, avoid, liked) as elongated attention
 * chips — not the same shape as the score card, on purpose.
 */
function DirectedChip({ item }: { item: SummaryDirected }) {
  const presentation = directedPresentation(item.questionKey);
  const Icon = presentation.icon;

  return (
    <li
      className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3.5 py-3 sm:min-w-[12rem] ${presentation.chip}`}
    >
      <Icon
        aria-hidden="true"
        className={`size-4 shrink-0 ${presentation.className}`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-ink-muted">
          {item.label}
        </p>
        <p className="mt-0.5 text-sm text-ink">
          <span className="font-display text-lg font-extrabold tabular-nums">
            {item.edgeCount}
          </span>
          <span className="text-ink-subtle">
            {" "}
            from {countLabel(item.respondentCount, "person", "people")}
          </span>
        </p>
      </div>
    </li>
  );
}

function SummaryMetrics({ document }: { document: SummaryDocument }) {
  const scores = document.metrics.scores.flatMap<ScoredMetric>((score) =>
    score.answerCount > 0 && score.average !== null
      ? [{ ...score, average: score.average }]
      : [],
  );
  const directed = document.metrics.directed.filter(
    (item) => item.edgeCount > 0,
  );

  if (scores.length === 0 && directed.length === 0) {
    return (
      <SectionEmpty>
        Nothing counted yet — no scored or person-valued answers have been
        recorded for this campaign.
      </SectionEmpty>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-start">
      {scores.length > 0 ? (
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">Score averages</p>
          <ul className="mt-3.5 grid gap-4">
            {scores.map((score) => (
              <ScoreRangeRow key={score.questionKey} score={score} />
            ))}
          </ul>
        </div>
      ) : null}

      {directed.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2.5">
          <p className="text-xs font-medium text-ink-muted">Who people named</p>
          <ul className="flex flex-col gap-2.5">
            {directed.map((item) => (
              <DirectedChip key={item.questionKey} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Plain bullets — section title + icon already carry meaning, so list items
 * stay typographic (curiosities, gossip, next actions).
 */
function BulletList({
  items,
  empty,
}: {
  items: readonly string[];
  empty: string;
}) {
  if (items.length === 0) {
    return <SectionEmpty>{empty}</SectionEmpty>;
  }

  return (
    <ul className="grid list-disc gap-3.5 pl-5 marker:text-ink-subtle">
      {items.map((item) => (
        <li key={item} className="pl-1 text-sm leading-relaxed text-ink">
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * Optional tea drawer: closed until staff open it. Hidden entirely when the
 * model left gossip empty — no empty tease. Lucide has no nail-polish glyph;
 * `Drama` is the nearest in-set tea/sass mark.
 */
function GossipDrawer({ items }: { items: readonly string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <details className="group min-w-0 rounded-xl bg-surface-sunken px-4 py-1 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3.5 marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2 jts-overline text-ink-muted">
          <Drama
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-subtle"
          />
          Κουτσομπολιό
          <span className="font-sans text-xs font-medium normal-case tracking-normal text-ink-subtle">
            ({items.length})
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-ink-subtle transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border-subtle pb-4 pt-3.5">
        <BulletList items={items} empty="" />
      </div>
    </details>
  );
}

function TintedFindingCard({
  icon: Icon,
  title,
  items,
  empty,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  items: readonly string[];
  empty: string;
  tone: "success" | "danger";
}) {
  const shell = tone === "success" ? "bg-success-soft" : "bg-danger-soft";
  const iconTone = tone === "success" ? "text-success" : "text-danger";

  return (
    <section className={`min-w-0 rounded-lg px-4 py-4 ${shell}`}>
      <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon aria-hidden="true" className={`size-4 shrink-0 ${iconTone}`} />
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">{empty}</p>
      ) : (
        <ul className="mt-3 grid gap-2.5">
          {items.map((item) => (
            <li key={item} className="text-sm leading-relaxed text-ink">
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionList({ items }: { items: readonly string[] }) {
  return (
    <BulletList items={items} empty="No concrete next steps from this round." />
  );
}

function StructuredSummary({ document }: { document: SummaryDocument }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <ReportIsland title="The night in numbers" icon={UsersRound}>
        <SummaryMetrics document={document} />
      </ReportIsland>

      <ReportIsland title="How it felt" icon={CircleCheck}>
        <div className="grid gap-3.5">
          <TintedFindingCard
            icon={CircleCheck}
            title="What went well"
            items={document.wentWell}
            empty="Nothing clear enough to call out."
            tone="success"
          />
          <TintedFindingCard
            icon={CircleAlert}
            title="What went wrong"
            items={document.wentWrong}
            empty="No complaints or flags to summarise."
            tone="danger"
          />
        </div>
      </ReportIsland>

      <ReportIsland title="Αξιοπερίεργα" icon={Sparkles}>
        <BulletList
          items={document.curiosities}
          empty="Τίποτα αρκετά αξιοπερίεργο αυτή τη φορά."
        />
      </ReportIsland>

      <GossipDrawer items={document.gossip} />

      <ReportIsland title="What we do next" icon={ListTodo}>
        <ActionList items={document.actions} />
      </ReportIsland>

      {document.missing ? (
        <p className="rounded-xl bg-warning-soft px-4 py-4 text-sm text-ink sm:px-5">
          <span className="font-semibold">Still missing: </span>
          {document.missing}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Collapsible AI narrative for the open campaign: status in the header, body
 * and regenerate control when expanded. Polls only while generation is pending.
 */
export function CampaignSummary({ campaignId }: CampaignSummaryProps) {
  const queryClient = useQueryClient();

  const summaryQuery = useGetFeedbackCampaignSummary(campaignId, {
    query: {
      enabled: campaignId !== "",
      refetchInterval: (query) =>
        query.state.data?.status === "pending"
          ? CAMPAIGN_SUMMARY_POLL_INTERVAL_MS
          : false,
    },
  });

  const requestSummary = useRequestFeedbackCampaignSummary();
  const summary = summaryQuery.data;

  // Elapsed time is read as of the last successful fetch rather than of the
  // render. Reading `dataUpdatedAt` is also what keeps it moving: structural
  // sharing hands back an identical `data` on an unchanged poll, so a render
  // clock would both sit frozen on the stalled row this label exists to expose
  // and be impure here. It is only ever read alongside `data`, which is what
  // stamped it.
  const asOf = new Date(summaryQuery.dataUpdatedAt);
  const pendingPhase = summary
    ? campaignSummaryPendingPhase(summary, asOf)
    : null;

  const statusLabel = summary
    ? campaignSummaryStatusLabel(summary, asOf)
    : summaryQuery.isPending
      ? "Loading…"
      : "Not generated";
  const statusClass = summary
    ? statusToneClass(summary, pendingPhase)
    : "text-ink-muted";
  const actionLabel = campaignSummaryActionLabel(summary?.status ?? "none");
  const partialWarning = summary
    ? campaignSummaryPartialWarning(summary)
    : null;
  const meta = summary ? metaParts(summary) : [];
  const generating = summary?.status === "pending";
  const requestPending = requestSummary.isPending;
  const document = summary?.document ?? null;
  const legacyBody = !document && summary?.body ? summary.body : null;

  async function handleRequest() {
    try {
      await requestSummary.mutateAsync({ campaignId });
      await queryClient.invalidateQueries({
        queryKey: getGetFeedbackCampaignSummaryQueryKey(campaignId),
      });
    } catch (cause) {
      toast(apiErrorMessage(cause, "The summary could not be requested."), {
        variant: "danger",
      });
    }
  }

  return (
    <details className="jts-disclosure group min-w-0 rounded-lg border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2 jts-overline text-ink-muted transition-colors group-hover:text-ink">
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
          />
          <span className="truncate">Campaign summary</span>
        </span>
        <span
          className={`shrink-0 text-xs font-semibold tabular-nums ${statusClass}`}
        >
          {statusLabel}
        </span>
      </summary>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 border-t border-border px-4 py-5 sm:px-5">
        {summaryQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            {apiErrorMessage(
              summaryQuery.error,
              "Failed to load the campaign summary.",
            )}
          </p>
        ) : null}

        {summary?.status === "failed" && summary.error ? (
          <p role="alert" className="text-sm text-danger">
            {summary.error}
          </p>
        ) : null}

        {document ? <StructuredSummary document={document} /> : null}

        {legacyBody ? (
          /*
           * Legacy markdown bodies from before the structured document. Keep
           * the assistant renderer so an old ready row still reads correctly
           * until it is refreshed.
           */
          <div className="assistant-markdown max-w-none">
            <AssistantMarkdown>{legacyBody}</AssistantMarkdown>
          </div>
        ) : null}

        {!document && !legacyBody && summary?.status === "none" ? (
          <SectionEmpty>
            No summary yet. Generate one from the answers and notes collected so
            far.
          </SectionEmpty>
        ) : null}

        {!document && !legacyBody && pendingPhase ? (
          <p className="text-sm text-ink-muted">
            {campaignSummaryPendingDetail(pendingPhase)}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-subtle pt-3">
          {meta.length > 0 || partialWarning ? (
            <div className="grid min-w-0 gap-0.5 text-xs text-ink-muted">
              {meta.length > 0 ? <p>{meta.join(" · ")}</p> : null}
              {partialWarning ? (
                <p className="font-medium text-warning">{partialWarning}</p>
              ) : null}
            </div>
          ) : null}

          <Button
            size="sm"
            variant="secondary"
            isPending={requestPending}
            isDisabled={generating || requestPending || campaignId === ""}
            onPress={() => {
              void handleRequest();
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </details>
  );
}
