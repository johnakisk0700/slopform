import { buttonVariants } from "@heroui/react";
import {
  BarChart3,
  FlaskConical,
  PauseCircle,
  PlayCircle,
  SquareX,
  Unplug,
} from "lucide-react";
import { Link } from "react-router";

import type { FeedbackCampaignConversationsDtoOutputCampaign } from "../../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaign";
import type { EventVenueValue } from "../../../features/event/venue";
import { campaignStatusBadge } from "../../../features/feedback/labels";
import { JtsBackLink } from "../../ui/JtsBackLink";
import { VenueCompact } from "../events/VenueDisplay";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";

interface CampaignHeaderProps {
  campaign: FeedbackCampaignConversationsDtoOutputCampaign | undefined;
  pausePending: boolean;
  resumePending: boolean;
  closePending: boolean;
  simulatorAvailable: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onClose: () => Promise<void>;
}

export function CampaignHeader({
  campaign,
  pausePending,
  resumePending,
  closePending,
  simulatorAvailable,
  onPause,
  onResume,
  onClose,
}: CampaignHeaderProps) {
  const campaignBusy = pausePending || resumePending || closePending;

  return (
    /* Two rows, not four. This header used to stack the back link, an eyebrow,
       the title, an actions row and the campaign line — ~230px before the
       first message of the transcript this screen exists for. The eyebrow is
       gone (the sidebar item and the back link already place the page) and the
       actions share the back link's line.

       What is left is the page saying what page it is: the way out, what you
       can do to this campaign, and its name. The venue and the exceptions moved
       to `CampaignContext` below, because they answer «what is true about this
       campaign right now» — a question the summary card underneath also
       answers, and the title does not.

       Grid rather than two stacked flex rows, because the order is not the same
       at both sizes. Wide, the actions ride the back link's line and the title
       spans under both. Narrow, three controls cannot share a 375px line with
       the way out, and stacking them in that order put ~200px of buttons above
       the title — the operator met «Close campaign» before learning which
       campaign. Source order is back, title, actions; the `sm:` placement is
       what lifts the actions back up beside the exit, so the DOM reads the way
       the phone does and only the wide screen rearranges. */
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-y-2">
      {/* A back affordance, not a peer of the campaign's own actions: it
          leaves this campaign rather than doing something to it. The shared
          JtsBackLink, so this screen's exit is the one every other screen
          has — the compact header only decides that it shares the actions'
          line instead of standing on its own. */}
      {/* Wrapped, and the wrapper is the point. `JtsBackLink` carries its own
          `self-start` — right in the column layouts the other detail screens
          put it in, where it must not stretch — and as a direct grid item that
          `self-start` beats this row's `items-center`, so the link sat pinned
          to the top of a row whose height the 36px action pills set. Against
          them it read about 8px high. The wrapper takes the alignment; the
          link keeps its own contract.

          `flex` and not a bare block: a block wrapper is a 25.6px line box, an
          inline-flex child sits on its baseline, and the link came out 2.3px
          high inside a wrapper that was itself perfectly centred. Flex makes
          the wrapper exactly as tall as the link, so centring the wrapper
          centres the link. */}
      <div className="flex">
        <JtsBackLink to="/admin/feedback">Back to campaigns</JtsBackLink>
      </div>

      {/* No `jts-title-mark`. The six dots are the app signing a page: they sit
          under «Events», «Participants», «Feedback campaigns» — names the
          product chose for its own screens. This h1 is not one of those. It is
          `campaign.eventTitle`, a dinner someone typed, and the mark under it
          read as the app claiming authorship of the operator's data — a brand
          flourish decorating a value.

          Losing it also buys the thing this screen wants most: the mark cost
          11px between the name and the context band directly under it, and
          without it the dinner's name and the facts about that dinner close up
          into one block. The campaign gets easier to see by having less
          attached to it, not more.

          And `font-sans`, not the `font-display` every other h1 wears. The two
          faces already mean something in this admin: Commissioner is the
          product's voice — it sets the names the product chose for its own
          screens — and Manrope sets everything a person typed. On this screen
          that is not a fine distinction, it is most of what is on it: the
          participants in the list, the messages in the thread, the venue's
          name. All Manrope. The campaign's title is the same kind of thing as
          all of it, so it is set in the same face, and the difference from a
          page title is legible before a word of it is read.

          (`font-brand`/Sora, the third face, is not a candidate: it is the
          wordmark's alone and carries no Greek — and these titles are Greek.)

          `tracking-tight` because Manrope runs wider than Commissioner at
          extrabold, and the line should still read as one name.

          `pl-[3px]` is optical, not structural, which is why it is off the
          spacing scale. The h1's box already sits flush with the column —
          same x as the context band's border below — but Manrope's extrabold
          Δ and Τ carry ~0.2–0.4px of left sidebearing where H, D or F carry
          ~1.5px, and these titles are Greek dinner names that mostly open on
          exactly those diagonals. Flush at 22px, that ink reads as leaning
          out past the border under it. The first pixel seats the diagonal
          where the square letters already sit; the other two settle the name
          just inside the column edge. 4px was tried and overshot — it stops
          reading as an aligned title and starts reading as an indent. */}
      <h1 className="min-w-0 truncate pl-[3px] font-sans text-[1.375rem] font-extrabold tracking-tight sm:col-span-2 sm:row-start-2">
        {campaign?.eventTitle ?? "Feedback conversations"}
      </h1>

      <div className="flex min-w-0 flex-nowrap items-center gap-2 sm:col-start-2 sm:row-start-1 sm:justify-self-end sm:gap-3">
        {simulatorAvailable ? (
          <span
            title="Simulated transport"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-ink-muted"
          >
            <FlaskConical aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Simulated transport</span>
          </span>
        ) : null}

        {campaign ? (
          /* The same pill the two actions are cut from, in the lightest
             variant. It used to be bare text beside them, which reads fine on
             one wide line and badly on a wrapped narrow one: a text label and
             a button label start at different offsets, so the column of
             controls came out ragged. Same shape, different weight — the
             hierarchy survives the alignment. */
          <Link
            to={`/admin/feedback/${campaign.id}/results`}
            /* `outline-solid` is the focus ring, not a decoration. HeroUI's
               `.button` clears `outline-style` because its own components take
               focus from react-aria's `data-focus-visible`, which a plain
               anchor never gets — so the base layer's ring arrived with its
               width, colour and offset intact and `style: none`, i.e. invisible.
               Restoring only the style hands this link the exact ring every
               other native element on the app has, without naming a colour. */
            aria-label="Campaign results"
            className={`${buttonVariants({ variant: "ghost", size: "sm" })} max-sm:min-h-8 max-sm:min-w-8 max-sm:px-2 focus-visible:outline-solid`}
          >
            <BarChart3 aria-hidden="true" className="size-4 shrink-0" />
            <span className="max-sm:hidden">Results</span>
          </Link>
        ) : null}

        {/* Reading the campaign's output and changing its state are two
            different kinds of act; a hairline says so without a heading. Wide
            only — on a wrapped row it would land at the start of a line and
            divide nothing. */}
        {campaign && campaign.status !== "closed" ? (
          <span
            aria-hidden="true"
            className="hidden h-6 self-center border-l border-border sm:block"
          />
        ) : null}

        {campaign?.status === "launched" ? (
          <ConfirmAction
            label="Pause campaign"
            icon={<PauseCircle aria-hidden="true" className="size-4" />}
            heading="Pause this campaign"
            description="Queued messages stop going out until you resume. Conversations already open stay open, and replies still arrive."
            confirmLabel="Pause campaign"
            collapseLabelAt="sm"
            isPending={pausePending}
            isDisabled={campaignBusy}
            onConfirm={onPause}
          />
        ) : null}

        {campaign?.status === "paused" ? (
          <ConfirmAction
            label="Resume campaign"
            icon={<PlayCircle aria-hidden="true" className="size-4" />}
            heading="Resume this campaign"
            description="Queued messages start going out again, including anything held while the campaign was paused."
            confirmLabel="Resume campaign"
            collapseLabelAt="sm"
            isPending={resumePending}
            isDisabled={campaignBusy}
            onConfirm={onResume}
          />
        ) : null}

        {campaign && campaign.status !== "closed" ? (
          <ConfirmAction
            label="Close campaign"
            tone="danger"
            icon={<SquareX aria-hidden="true" className="size-4" />}
            heading="Close this campaign"
            description="The kill switch: nothing further is sent and everything still queued is cancelled. Open conversations are left to STOP, expiry or a staff close. This cannot be undone."
            confirmLabel="Close campaign"
            collapseLabelAt="sm"
            isPending={closePending}
            isDisabled={campaignBusy}
            onConfirm={onClose}
          />
        ) : null}
      </div>
    </div>
  );
}

interface CampaignContextProps {
  campaign: FeedbackCampaignConversationsDtoOutputCampaign | undefined;
  venue: EventVenueValue | null;
}

/**
 * One framed line of standing context, between the title and the summary card.
 *
 * It used to hang off the title: the venue in a sunken box 8px under the six-dot
 * mark, the exceptions floating bottom-aligned beside it. That glued two facts
 * about the *campaign* onto the page's own nameplate, and put a second bordered
 * block directly under the mark where the eye is still reading the heading.
 *
 * Then it was a bare row, venue at one end and exceptions at the other. Wide,
 * that read; narrow, `justify-between` collapses to a stack, and the band came
 * out as three different treatments in a row — an outlined venue, a bare status
 * line, a filled summary card — which is what «κακάσχημη» was pointing at.
 *
 * So the border belongs to the *band*, not to the venue inside it. One ghost
 * frame, one line: the venue owns the shrinking width and its qualifiers
 * truncate before exceptional campaign/model state can force a second row.
 *
 * Full width, and not the `w-fit` this was first drawn with. Hugging sounds
 * right — a short band should not pretend to be a card — but the content here is
 * long enough that it landed 900px into a 931px column: a 31px miss reads as a
 * frame that failed to stretch, not as one that chose its size. It shares the
 * column with everything else on the screen instead.
 *
 * Ghost and not filled: `CampaignSummary` directly under it is the filled one,
 * and two filled blocks would make two cards out of one thought. That is also
 * what keeps a venue-only campaign honest — a wide outline with one line in it
 * is a status band, the same shape the collapsed summary under it takes.
 *
 * Nothing at all when there is no venue and no exception: a launched campaign
 * with everything running states itself with silence, and the transcript gets
 * the row back.
 */
export function CampaignContext({ campaign, venue }: CampaignContextProps) {
  const hasException =
    campaign !== undefined &&
    (campaign.status !== "launched" || campaign.extractionParkedCount > 0);

  if (!venue && !hasException) {
    return null;
  }

  return (
    /* One non-wrapping line. Venue qualifiers give way first; the exceptional
       status group stays compact and readable at the right edge. */
    <div className="flex min-w-0 items-center gap-3 overflow-hidden rounded-lg border border-border px-4 py-2">
      {venue ? (
        <section aria-label="Dinner venue" className="min-w-0 flex-1">
          <VenueCompact venue={venue} />
        </section>
      ) : null}

      {/* Only campaign/model exceptions remain here. Attention belongs to the
          list that owns its rows; simulated transport lives in the toolbar. */}
      {hasException ? (
        <div className="flex shrink-0 flex-nowrap items-center gap-x-3 whitespace-nowrap text-sm text-ink-muted">
          {campaign.status !== "launched" ? (
            <FeedbackBadges badges={[campaignStatusBadge(campaign.status)]} />
          ) : null}
          {/* An unplugged cable says «the
              model is unreachable» in a way a second warning triangle would
              not. Below `sm`, only the count remains visible so the location
              line cannot wrap. */}
          {campaign.extractionParkedCount > 0 ? (
            <p
              aria-label={`${campaign.extractionParkedCount} waiting on the model`}
              className="flex items-center gap-1.5 font-semibold text-info"
            >
              <Unplug aria-hidden="true" className="size-4 shrink-0" />
              <span className="tabular-nums">
                {campaign.extractionParkedCount}
              </span>
              <span className="max-sm:hidden">waiting on the model</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
