import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import {
  Archive,
  CalendarClock,
  Clock,
  Layers,
  MessageCircleMore,
  PauseCircle,
  Rocket,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import type { FeedbackCampaignListDtoOutputItemsItem } from "../api/generated/model/feedbackCampaignListDtoOutputItemsItem";
import type { FeedbackCampaignListDtoOutputItemsItemStatus } from "../api/generated/model/feedbackCampaignListDtoOutputItemsItemStatus";
import { useListEvents } from "../api/generated/events";
import {
  useLaunchFeedbackCampaign,
  useListFeedbackCampaigns,
} from "../api/generated/feedback-campaigns";
import { VenueLine } from "../components/admin/events/VenueDisplay";
import { ConfirmAction } from "../components/admin/feedback/ConfirmAction";
import { FeedbackBadges } from "../components/admin/feedback/FeedbackBadges";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import type { EventVenueValue } from "../features/event/venue";
import { formatTimestamp } from "../features/feedback/conversationView";
import { campaignStatusBadge } from "../features/feedback/labels";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

type CampaignRow = FeedbackCampaignListDtoOutputItemsItem;
type CampaignStatus = FeedbackCampaignListDtoOutputItemsItemStatus;

interface CampaignSectionSpec {
  status: CampaignStatus;
  Icon: LucideIcon;
  /** The glyph's own colour. Matches the status tone `campaignStatusBadge` gives. */
  tint: string;
  /** One line saying what being in this section means for the operator. */
  lede: string;
}

/**
 * Reading order, and it is triage order rather than the API's newest-first.
 *
 * A launched campaign is collecting answers right now; a paused one is a
 * decision somebody has to come back and make; a closed one is history. Sorting
 * by launch time across all three mixed those together, so the campaign that
 * had been sitting paused for a week was wherever its launch date happened to
 * put it.
 *
 * The glyphs are the ones this feature already speaks in — `Archive` heads the
 * closed conversations in `ConversationList`, `PauseCircle` is the pause control
 * in `CampaignHeader`, and `Rocket` is the launch action at the bottom of this
 * very page, so a campaign appears under the glyph of the button that created
 * it. Nothing new was drawn for this.
 */
/**
 * How the picker is arranged. Two answers to two different questions.
 *
 * «By status» answers «what needs me?» and is the default, because that is why
 * an operator opens this screen. «By date» answers «which dinner was that?» —
 * one run of cards newest first, which is the only order that works when you
 * are looking for a campaign whose state you do not remember.
 *
 * It is a view toggle and nothing else: same campaigns, same cards, no filter.
 * Nothing is ever hidden by switching, so there is no state in which the
 * operator is looking at a subset without being told.
 */
type CampaignOrdering = "status" | "date";

const ORDERING_OPTIONS: ReadonlyArray<{
  value: CampaignOrdering;
  label: string;
  Icon: LucideIcon;
}> = [
  { value: "status", label: "By status", Icon: Layers },
  { value: "date", label: "By date", Icon: CalendarClock },
];

/** Matches `AdminUserMenu`'s appearance chips — the app's one segmented look. */
const CHOICE_CHIP =
  "justify-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-ink " +
  "data-[selected]:border-primary-border data-[selected]:bg-primary-soft data-[selected]:text-primary";

const CAMPAIGN_SECTIONS: readonly CampaignSectionSpec[] = [
  {
    status: "launched",
    Icon: Rocket,
    tint: "text-success",
    lede: "Collecting answers now.",
  },
  {
    status: "paused",
    Icon: PauseCircle,
    tint: "text-warning",
    lede: "Nothing is going out until somebody resumes these.",
  },
  {
    status: "closed",
    Icon: Archive,
    tint: "text-ink-subtle",
    lede: "Finished. Read-only, kept for their results.",
  },
];

/**
 * The way into a feedback campaign.
 *
 * Campaigns come from `listFeedbackCampaigns` — a read-only staff list with
 * event titles and conversation progress. Launching remains a separate,
 * confirmed write: `launchFeedbackCampaign` also opens conversations and
 * queues intros for newly eligible attendees, so it must never be used merely
 * to look at an inbox.
 */
export function FeedbackCampaignsPage() {
  const navigate = useNavigate();
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState<CampaignOrdering>("status");
  const orderingLabelId = useId();

  usePageMeta(
    "Feedback campaigns",
    "Open a post-event feedback campaign's conversation inbox.",
  );

  const campaignsQuery = useListFeedbackCampaigns();
  const eventsQuery = useListEvents();
  const launchCampaign = useLaunchFeedbackCampaign();

  const campaigns = useMemo(
    () => campaignsQuery.data?.items ?? [],
    [campaignsQuery.data?.items],
  );

  /* The campaign list DTO carries the event's title but not its venue, and this
     page already holds every event for the section below — `listEvents` is
     unbounded, so the join is complete rather than "complete for the first
     page". A venue-bearing campaign DTO would be the tidier answer, but it is
     a backend change to put a fact on screen that is already in the browser.

     Missing is silent by design: no venue recorded and events-still-loading
     both render nothing. The alternative — a placeholder row — would spend a
     line of a 3-across card saying that nothing is known. */
  const venueByEventId = useMemo(() => {
    const byId = new Map<string, EventVenueValue>();
    for (const event of eventsQuery.data?.items ?? []) {
      if (event.venue) byId.set(event.id, event.venue);
    }
    return byId;
  }, [eventsQuery.data?.items]);

  /* One bucket per status, in `CAMPAIGN_SECTIONS` order. The API's newest-first
     ordering survives inside each bucket, so a section is still a timeline. */
  const campaignsByStatus = useMemo(() => {
    const byStatus = new Map<CampaignStatus, CampaignRow[]>();
    for (const entry of campaigns) {
      const bucket = byStatus.get(entry.status);
      if (bucket) bucket.push(entry);
      else byStatus.set(entry.status, [entry]);
    }
    return byStatus;
  }, [campaigns]);

  const finishedEventsWithoutCampaign = useMemo(() => {
    const withCampaign = new Set(campaigns.map((row) => row.eventId));
    return (eventsQuery.data?.items ?? []).filter(
      (event) => event.status === "finished" && !withCampaign.has(event.id),
    );
  }, [campaigns, eventsQuery.data?.items]);

  async function handleLaunch(eventId: string) {
    setLaunchError(null);
    try {
      const campaign = await launchCampaign.mutateAsync({ data: { eventId } });
      await navigate(`/admin/feedback/${campaign.id}`);
    } catch (cause) {
      setLaunchError(
        apiErrorMessage(cause, "The campaign could not be launched or opened."),
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Post-event feedback"
        title="Feedback campaigns"
        description="One dinner, one campaign, one chance to ask. Open a campaign to read what came back — and to step in where the bot should not answer alone."
      />

      {launchError ? (
        <p role="alert" className="text-sm text-danger">
          {launchError}
        </p>
      ) : null}

      {campaignsQuery.isPending ? (
        <p role="status" className="text-sm text-ink-muted">
          Loading campaigns…
        </p>
      ) : campaignsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          {apiErrorMessage(campaignsQuery.error, "Failed to load campaigns.")}
        </p>
      ) : campaigns.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No campaigns yet. Launch one from a finished event below.
        </p>
      ) : (
        <>
          {/* Only worth offering once there is more than one status to group
              by. With every campaign launched, the two views render the same
              screen, and a control that changes nothing is chrome charging
              rent on the row above the content. */}
          {campaignsByStatus.size > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span id={orderingLabelId} className="jts-overline text-ink-muted">
                Campaigns {campaigns.length}
              </span>
              <ToggleButtonGroup
                aria-labelledby={orderingLabelId}
                selectionMode="single"
                disallowEmptySelection
                isDetached
                selectedKeys={[ordering]}
                onSelectionChange={(keys) => {
                  const [next] = keys;
                  if (next === "status" || next === "date") setOrdering(next);
                }}
              >
                {ORDERING_OPTIONS.map(({ value, label, Icon }) => (
                  <ToggleButton
                    key={value}
                    id={value}
                    size="sm"
                    className={CHOICE_CHIP}
                  >
                    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                    {label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>
          ) : null}

          {ordering === "date" ? (
            /* One run, newest first — which is the order the API already
               returns, so this view sorts nothing and cannot disagree with the
               sectioned one. The cards carry their status badge here because
               the headings that were naming it are gone, and a state must
               never be knowable from a tint alone. */
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {campaigns.map((entry) => (
                <li key={entry.id}>
                  <CampaignCard
                    entry={entry}
                    venue={venueByEventId.get(entry.eventId) ?? null}
                    showStatus
                  />
                </li>
              ))}
            </ul>
          ) : (
            /* One section per status, and an empty status renders nothing at
               all — not a heading over «None». A workspace where every campaign
               is running should look like one screen of live campaigns, not
               like a form with two blanks in it. */
            CAMPAIGN_SECTIONS.map((spec) => {
              const rows = campaignsByStatus.get(spec.status) ?? [];
              if (rows.length === 0) return null;
              return (
                <CampaignSection
                  key={spec.status}
                  spec={spec}
                  rows={rows}
                  venueByEventId={venueByEventId}
                />
              );
            })
          )}
        </>
      )}

      <section
        aria-labelledby="finished-events"
        className="flex flex-col gap-3"
      >
        <h2 id="finished-events" className="jts-overline text-ink-muted">
          Finished events without a campaign
        </h2>

        {eventsQuery.isPending ? (
          <p role="status" className="text-sm text-ink-muted">
            Loading events…
          </p>
        ) : eventsQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            {apiErrorMessage(eventsQuery.error, "Failed to load events.")}
          </p>
        ) : finishedEventsWithoutCampaign.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Every finished event already has a campaign, or none are finished
            yet. Mark an event finished on{" "}
            <Link to="/admin/events" className="font-semibold text-primary">
              the events screen
            </Link>{" "}
            before launching.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {finishedEventsWithoutCampaign.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">
                    {event.title}
                  </p>
                  <p className="text-xs text-ink-muted tabular-nums">
                    {event.presentCount} present of {event.attendeeCount}{" "}
                    attendees
                  </p>
                </div>
                <ConfirmAction
                  label="Launch campaign"
                  icon={<Rocket aria-hidden="true" className="size-4" />}
                  heading={`Feedback campaign for ${event.title}`}
                  description={
                    <>
                      Creates this event&rsquo;s feedback campaign and queues a
                      conversation plus an intro message for every attendee who
                      is marked present, opted in and has a phone number.
                      Existing conversations are never duplicated or reopened.
                    </>
                  }
                  confirmLabel="Launch"
                  isPending={launchCampaign.isPending}
                  isDisabled={launchCampaign.isPending}
                  onConfirm={() => handleLaunch(event.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
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
function CampaignSection({
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

/**
 * A campaign as three lines: what dinner, where, and how it is going.
 *
 * It used to carry a status pill in its top-right corner. Under a heading that
 * already names the status, that pill said the same word twice and took the
 * room the event's title wanted — Greek dinner names are long and were
 * truncating at «Δοκιμαστικό δείπνο — Μεζεδοπω…» to make space for a chip
 * repeating the section above it.
 *
 * The tallies lost their sentences for the same reason. «6 open of 6 · 4 need
 * attention» is a line of prose describing two numbers; as glyph-and-number
 * pairs the numbers are what the eye lands on, the row fits beside the
 * timestamp instead of under it, and the two that matter carry their status
 * tone. The sentences are not gone — every stat keeps its full wording for a
 * screen reader and in the hover title, so nothing is knowable by glyph alone.
 */
function CampaignCard({
  entry,
  venue,
  showStatus = false,
}: {
  entry: CampaignRow;
  venue: EventVenueValue | null;
  /** Set in the by-date view, where no heading is naming the status. */
  showStatus?: boolean;
}) {
  /* Colour on this screen means «there is something here to do». A closed
     campaign has nothing: its conversations cannot be answered, its parked
     extractions will never run, and its «4 need attention» is a fact about
     something that already happened. So the status tints drain out and the
     numbers stay — the tally is still history worth reading, it just stops
     asking for a person.

     Paused deliberately gets none of this. It was the other candidate for
     fading, and it is the wrong one: a paused campaign is the single state on
     this page that is waiting on a human decision, so dimming it would hide
     the only card anybody has to come back to. Its section already carries the
     amber pause glyph, which is the right amount of «look here». */
  const archived = entry.status === "closed";
  const attentionTint = archived
    ? "text-ink-subtle"
    : "font-semibold text-warning";
  const parkedTint = archived ? "text-ink-subtle" : "font-semibold text-info";

  /* The 3px left marker in the status tone — this admin's only emphasis motif,
     and the reason a paused card can be told from a live one with the headings
     stripped away. Launched takes no marker: it is the ordinary state of a
     working campaign, and marking the majority is how a marker stops meaning
     anything. Closed takes none either; being drained of colour is already its
     whole treatment, and an archived card does not need pointing at. */
  const marker =
    entry.status === "paused" ? "border-l-[3px] border-l-warning" : "";

  return (
    <Link
      to={`/admin/feedback/${entry.id}`}
      /* Archived cards are desaturated and set back, and they come all the way
         forward on hover or keyboard focus. The restore is the part that makes
         this honest rather than decorative: a closed campaign still holds the
         results somebody came here to read, so it has to keep saying «I open»
         when you reach for it. A permanently faded card reads as disabled.

         `grayscale` and not just opacity, because this theme's surfaces are a
         warm plum — draining the warmth is what actually reads as «archived»
         here, while opacity alone just reads as «loading». Held at 75 rather
         than lower so the dinner's name stays comfortably legible; the fade is
         meant to rank these cards, not to retire them. */
      className={`block rounded-md border border-border bg-surface px-4 py-3 no-underline transition hover:border-primary-border ${marker} ${
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
          <CampaignStat
            Icon={TriangleAlert}
            value={String(entry.needsAttentionCount)}
            description={`${entry.needsAttentionCount} need attention`}
            tint={attentionTint}
          />
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
