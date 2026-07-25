import { z } from "zod";

/**
 * A local shortcut list of campaigns this browser has already opened.
 *
 * The backend publishes no "list campaigns" operation and the event read model
 * carries no campaign id, so the only server-side way to turn an event into a
 * campaign id is `launchFeedbackCampaign` — a write that also opens
 * conversations and enqueues intros for newly eligible attendees. Pressing it
 * to merely *look* at an inbox would message people, so the screen remembers
 * the ids it has already seen instead.
 *
 * This cache is a convenience, never an authority: the campaign id in the URL
 * is the truth, entries are validated on read, and anything unparseable is
 * dropped rather than repaired. Replace this with the real endpoint when the
 * backend grows one.
 */

const STORAGE_KEY = "jts-feedback-recent-campaigns";
const MAX_ENTRIES = 12;

export const recentCampaignSchema = z.object({
  campaignId: z.uuid(),
  eventId: z.uuid(),
  eventTitle: z.string().min(1).max(200),
  openedAt: z.iso.datetime(),
});

export type RecentCampaign = z.infer<typeof recentCampaignSchema>;

export const recentCampaignsSchema = z.array(recentCampaignSchema);

/**
 * Puts `entry` at the front, de-duplicated by campaign id, and caps the list.
 * Pure so the ordering rule is testable without a browser.
 */
export function mergeRecentCampaign(
  existing: readonly RecentCampaign[],
  entry: RecentCampaign,
): RecentCampaign[] {
  const withoutEntry = existing.filter(
    (row) => row.campaignId !== entry.campaignId,
  );
  return [entry, ...withoutEntry].slice(0, MAX_ENTRIES);
}

export function readRecentCampaigns(): RecentCampaign[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = recentCampaignsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    // A quota-blocked, disabled or corrupted store is not worth an error
    // state: the operator still has the URL and the launch action.
    return [];
  }
}

export function rememberRecentCampaign(entry: RecentCampaign): void {
  if (typeof window === "undefined") {
    return;
  }

  const parsed = recentCampaignSchema.safeParse(entry);
  if (!parsed.success) {
    return;
  }

  try {
    const next = mergeRecentCampaign(readRecentCampaigns(), parsed.data);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignored for the same reason as above.
  }
}
