import {
  Clock,
  MessageCircleMore,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";

import { VenueLine } from "../../components/admin/events/VenueDisplay";
import { FeedbackBadges } from "../../components/admin/feedback/FeedbackBadges";
import type { EventVenueValue } from "../../features/event/venue";
import { formatTimestamp } from "../../features/feedback/conversationView";
import { campaignStatusBadge } from "../../features/feedback/labels";

import { type CampaignRow, type CampaignSectionSpec } from "./campaignSections";

/**
 * A navigable campaign summary: title, venue and progress. Lifecycle appears
 * in the section heading or the by-date status chip. Attention has a visible
 * labelled badge; other compact tallies retain their full accessible wording.
 */
export function CampaignCard({
  entry,
  venue,
  showStatus = false,
}: {
  entry: CampaignRow;
  venue: EventVenueValue | null;
  /** Set in the by-date view, where no heading is naming the status. */
  showStatus?: boolean;
}) {
  /* Only closed campaigns fade; paused campaigns still need an operator decision. */
  const archived = entry.status === "closed";
  const attentionTint = archived
    ? "bg-surface-sunken text-ink-subtle"
    : "bg-warning-soft text-warning";
  const parkedTint = archived ? "text-ink-subtle" : "font-semibold text-info";

  return (
    <Link
      to={`/admin/feedback/${entry.id}`}
      /* Restore archived cards on hover/focus so they remain visibly navigable. */
      className={`block rounded-md border border-border bg-surface px-4 py-3 no-underline transition hover:border-primary-border ${
        archived
          ? "opacity-75 grayscale hover:opacity-100 hover:grayscale-0 focus-visible:opacity-100 focus-visible:grayscale-0"
          : ""
      }`}
    >
      {showStatus ? (
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="block min-w-0 flex-1 truncate text-sm font-bold text-ink">
            {entry.eventTitle ?? "Untitled event"}
          </span>
          <FeedbackBadges badges={[campaignStatusBadge(entry.status)]} />
        </span>
      ) : (
        <span className="block min-w-0 truncate text-sm font-bold text-ink">
          {entry.eventTitle ?? "Untitled event"}
        </span>
      )}

      {/* Directly under the title, because it is the other half of naming this
          dinner rather than a fact about its progress. Two «Δοκιμαστικό
          δείπνο» cards are told apart by where they were long before they are
          told apart by how many conversations are still open. */}
      {venue ? (
        <span className="mt-1 block">
          <VenueLine venue={venue} muted={archived} />
        </span>
      ) : null}

      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <CampaignStat
          Icon={Clock}
          value={formatTimestamp(entry.launchedAt)}
          description={`Launched ${formatTimestamp(entry.launchedAt)}`}
        />
        <CampaignStat
          Icon={MessageCircleMore}
          value={`${entry.openCount}/${entry.conversationCount}`}
          description={`${entry.openCount} open of ${entry.conversationCount} conversations`}
        />
        {entry.needsAttentionCount > 0 ? (
          <span
            className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-semibold ${attentionTint}`}
          >
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="tabular-nums">
              {entry.needsAttentionCount} need attention
            </span>
          </span>
        ) : null}
        {/* Its own tone, because it is the one thing on a live campaign nobody
            can act on by opening it — the model is unreachable and the only
            cure is waiting or topping up. Rendered only above zero. */}
        {entry.extractionParkedCount > 0 ? (
          <CampaignStat
            Icon={Unplug}
            value={String(entry.extractionParkedCount)}
            description={`${entry.extractionParkedCount} waiting on the model`}
            tint={parkedTint}
          />
        ) : null}
      </span>
    </Link>
  );
}

/** A glyph, a number, and the sentence that number would have been. */
function CampaignStat({
  Icon,
  value,
  description,
  tint = "text-ink-muted",
}: {
  Icon: LucideIcon;
  value: string;
  description: string;
  tint?: string;
}) {
  return (
    <span
      title={description}
      className={`flex items-center gap-1 text-xs ${tint}`}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span aria-hidden="true" className="tabular-nums">
        {value}
      </span>
      <span className="sr-only">{description}</span>
    </span>
  );
}

/**
 * One status, its campaigns, and a count.
 *
 * The heading carries the glyph and the tone so the three sections are told
 * apart before a word is read — but it still spells the status out, because
 * colour and glyph are never the only signal on these screens. The count is on
 * the heading rather than on each card: «Paused 3» is the fact an operator
 * scanning this page wants, and it costs nothing to put it where the eye
 * already is.
 */
export function CampaignSection({
  spec,
  rows,
  venueByEventId,
}: {
  spec: CampaignSectionSpec;
  rows: readonly CampaignRow[];
  venueByEventId: ReadonlyMap<string, EventVenueValue>;
}) {
  const { Icon } = spec;
  const headingId = `campaigns-${spec.status}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2
          id={headingId}
          className="flex items-center gap-2 jts-overline text-ink-muted"
        >
          <Icon aria-hidden="true" className={`size-4 shrink-0 ${spec.tint}`} />
          {campaignStatusBadge(spec.status).label}
          <span className="tabular-nums text-ink-subtle">{rows.length}</span>
        </h2>
        <p className="text-xs text-ink-subtle">{spec.lede}</p>
      </div>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((entry) => (
          <li key={entry.id}>
            <CampaignCard
              entry={entry}
              venue={venueByEventId.get(entry.eventId) ?? null}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
