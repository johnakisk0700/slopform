import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useListEvents } from "../../api/generated/events";
import {
  useLaunchFeedbackCampaign,
  useListFeedbackCampaigns,
} from "../../api/generated/feedback-campaigns";
import type { EventVenueValue } from "../../features/event/venue";
import { apiErrorMessage } from "../../lib/api";

import {
  type CampaignOrdering,
  type CampaignRow,
  type CampaignStatus,
} from "./campaignSections";

export function useFeedbackCampaignsControls() {
  const navigate = useNavigate();

  const [launchError, setLaunchError] = useState<string | null>(null);

  const [ordering, setOrdering] = useState<CampaignOrdering>("status");

  const orderingLabelId = useId();

  const campaignsQuery = useListFeedbackCampaigns();

  const eventsQuery = useListEvents();

  const launchCampaign = useLaunchFeedbackCampaign();

  const campaigns = useMemo(
    () => campaignsQuery.data?.items ?? [],
    [campaignsQuery.data?.items],
  );

  /* listEvents is unbounded and already needed for launch candidates, so it supplies the complete venue join. Missing venues render nothing. */
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
  return {
    launchError,
    ordering,
    setOrdering,
    orderingLabelId,
    campaignsQuery,
    eventsQuery,
    launchCampaign,
    campaigns,
    venueByEventId,
    campaignsByStatus,
    finishedEventsWithoutCampaign,
    handleLaunch,
  };
}
