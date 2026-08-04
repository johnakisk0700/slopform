import { Input } from "@heroui/react";
import { clsx } from "clsx";
import {
  Archive,
  Inbox,
  MessageCircleMore,
  MessageSquareDashed,
  Search,
  SearchX,
  TriangleAlert,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";
import { useId } from "react";

import {
  conversationRowBadges,
  formatTimestamp,
  goalProgress,
  groupConversations,
  type ConversationGroupKey,
  type ConversationListItem,
} from "../../../features/feedback/conversationView";
import {
  isUnresolvedParticipant,
  participantLabel,
} from "../../../features/feedback/labels";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";

/** A present attendee with no conversation yet — a D17 start candidate. */
export interface StartCandidate {
  participantId: string;
  label: string;
}

interface ConversationListProps {
  conversations: readonly ConversationListItem[];
  selectedId: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (conversationId: string) => void;
  loading: boolean;
  error: string | null;
  /** Total before filtering, so the empty state can tell the two cases apart. */
  totalCount: number;
  /** True while the list query is refetching, for the live mark. */
  isRefreshing: boolean;
  /**
   * D17 candidates, rendered as their own quiet group at the list's foot: the
   * people who are at the event but have no conversation yet. Each row grows
   * its «Start» on hover or keyboard focus — the affordance lives on the
   * person it would start, not on a standalone button describing them.
   */
  startCandidates: readonly StartCandidate[];
  onStartConversation: (participantId: string) => Promise<void>;
  startPending: boolean;
  /** True when the campaign can no longer start anything (closed). */
  startDisabled: boolean;
}

/**
 * How each group announces itself. The heading is where an operator answers
 * "is anything waiting for me", so it carries the weight the rows deliberately
 * shed: its own fill, a strong hairline top and bottom, and the same glyph the
 * campaign tallies use for the same idea. Only NEEDS ATTENTION means "stop and
 * read this", so only it takes the 3px marker and the warning tone; the other
 * two reserve the marker's gutter so every heading label starts on one line.
 */
const GROUP_STYLES: Record<
  ConversationGroupKey,
  { icon: LucideIcon; heading: string }
> = {
  attention: {
    icon: TriangleAlert,
    heading:
      "border-warning-border border-l-warning bg-warning-soft text-warning",
  },
  open: {
    icon: MessageCircleMore,
    heading:
      "border-border-strong border-l-transparent bg-surface-sunken text-ink",
  },
  closed: {
    icon: Archive,
    heading:
      "border-border-strong border-l-transparent bg-surface-sunken text-ink-muted",
  },
};

/**
 * The inbox column: a text filter over one campaign's conversations, grouped
 * into the buckets an operator triages by (attention, open, closed).
 *
 * The grouping answers the first question an operator has, so the heading is
 * the loudest thing here and a row states only what its heading does not — see
 * `conversationRowBadges`. Rows spend their space on the name instead, which is
 * allowed two lines because a Greek full name truncated to one is not a person
 * any more.
 *
 * Choosing a row swaps the panes beside it rather than navigating, which is
 * what keeps a helpdesk operator's place while several threads move at once.
 * The selected row carries `aria-current`. Goal progress is one number in text
 * rather than a bar beside its own caption: a `<button>` may not contain the
 * `div`-based HeroUI `ProgressBar`, the text is what a screen reader reads out
 * of the row's name, and four goals give a bar five states it cannot express
 * more precisely than «2/4» already does.
 */
export function ConversationList({
  conversations,
  selectedId,
  query,
  onQueryChange,
  onSelect,
  loading,
  error,
  totalCount,
  isRefreshing,
  startCandidates,
  onStartConversation,
  startPending,
  startDisabled,
}: ConversationListProps) {
  const filterId = useId();
  const headingId = useId();
  const groupHeadingId = useId();
  const notStartedId = useId();

  const groups = groupConversations(conversations);

  return (
    <section
      aria-labelledby={headingId}
      /* Viewport-anchored cap only — the list sizes to its rows, never to an
         empty viewport. The transcript beside it stretches to this height via
         the grid; this pane stays `self-start` so it does not grow a blank
         foot under the last conversation. */
      className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface lg:max-h-[calc(100dvh-10rem)]"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h2
            id={headingId}
            className="flex items-center gap-2 jts-overline text-ink-muted"
          >
            <Inbox aria-hidden="true" className="size-4 shrink-0" />
            Conversations
            {/* What is in the list right now, so it stays true under a filter. */}
            <span className="font-bold tabular-nums opacity-70">
              {conversations.length}
            </span>
          </h2>
          <JtsLiveIndicator
            active={isRefreshing}
            label="This list refreshes automatically."
          />
        </div>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
          />
          <Input
            id={filterId}
            aria-label="Filter conversations by name or phone"
            placeholder="Filter by name or phone"
            value={query}
            onChange={(change) => onQueryChange(change.target.value)}
            className="w-full pl-9 text-ink-muted"
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="px-4 py-6 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading && conversations.length === 0 ? (
        <p role="status" className="px-4 py-6 text-sm text-ink-muted">
          Loading conversations…
        </p>
      ) : null}

      {!loading && !error && conversations.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          {totalCount === 0 ? (
            /* Not the header's own Inbox glyph: an icon that repeats inside
               its own section stops carrying information. */
            <MessageSquareDashed
              aria-hidden="true"
              className="mb-2 size-7 text-ink-subtle"
              strokeWidth={1.5}
            />
          ) : (
            <SearchX
              aria-hidden="true"
              className="mb-2 size-7 text-ink-subtle"
              strokeWidth={1.5}
            />
          )}
          <p className="text-sm font-semibold text-ink">
            {totalCount === 0 ? "No conversations yet" : "No matches"}
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {totalCount === 0
              ? "Conversations appear once the campaign launches its intros."
              : "Clear the filter to see the rest of the campaign."}
          </p>
        </div>
      ) : null}

      {conversations.length > 0 || startCandidates.length > 0 ? (
        <div className="min-h-0 flex-1 lg:overflow-y-auto">
          {groups.map((group) => {
            const style = GROUP_STYLES[group.key];
            const GroupIcon = style.icon;
            const groupId = `${groupHeadingId}-${group.key}`;

            return (
              /* The heading is the group in the markup too, so a screen
                 reader's grouping and a sighted operator's are the same one. */
              <section key={group.key} aria-labelledby={groupId}>
                <h3
                  id={groupId}
                  className={clsx(
                    "sticky top-0 z-10 flex items-center gap-2 border-y border-l-[3px] py-2 pr-4 pl-3.5 jts-overline",
                    style.heading,
                  )}
                >
                  <GroupIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  <span className="shrink-0 tabular-nums tracking-normal">
                    {group.conversations.length}
                  </span>
                </h3>
                <ul>
                  {group.conversations.map((conversation) => {
                    const isSelected = conversation.id === selectedId;
                    // The quiet archive recedes: a closed row's name drops to
                    // the muted ink its metadata already uses, so the working
                    // set is what pulls the eye. A token swap rather than
                    // opacity, because every muted pairing is measured AA and
                    // a faded chip is not.
                    const isArchived = group.key === "closed" && !isSelected;
                    const progress = goalProgress(conversation.goals);
                    const name = participantLabel(
                      conversation.respondentDisplayName,
                    );
                    const unresolved = isUnresolvedParticipant(
                      conversation.respondentDisplayName,
                    );
                    const badges = conversationRowBadges(
                      conversation,
                      group.key,
                    );

                    return (
                      <li
                        key={conversation.id}
                        className="border-b border-border-subtle last:border-b-0"
                      >
                        <button
                          type="button"
                          {...(isSelected ? { "aria-current": true } : {})}
                          onClick={() => onSelect(conversation.id)}
                          className={clsx(
                            "block w-full cursor-pointer px-4 py-2.5 text-left transition-colors",
                            isSelected
                              ? "bg-primary-soft"
                              : "hover:bg-surface-sunken",
                          )}
                        >
                          <span className="flex items-start justify-between gap-2">
                            {/* Two lines, not an ellipsis: «Κώστας
                                Αργοπληκτρολογάκιας» cut to the column width is
                                no longer a person an operator recognises. */}
                            <span
                              className={clsx(
                                "line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-bold break-words",
                                isSelected
                                  ? "text-primary"
                                  : isArchived
                                    ? "text-ink-muted"
                                    : "text-ink",
                                unresolved && "italic",
                              )}
                            >
                              {name}
                            </span>
                            {/* ink-muted, not ink-subtle: the selected row sits
                                on primary-soft, where subtle drops under AA. */}
                            <span className="shrink-0 pt-px text-[length:var(--jts-text-2xs)] font-semibold tabular-nums text-ink-muted">
                              {conversation.lastMessageAt === null
                                ? "—"
                                : formatTimestamp(conversation.lastMessageAt)}
                            </span>
                          </span>

                          {/* One metadata line, chips included: a row that
                              spent a third line on a single «Completed» pill
                              made the list a third longer for no more fact. */}
                          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-muted">
                            <span className="min-w-0 truncate tabular-nums">
                              {conversation.phoneAtLaunch}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0 font-semibold tabular-nums">
                              {progress.settled}/{progress.total} done
                            </span>
                            {badges.length > 0 ? (
                              <FeedbackBadges
                                badges={badges}
                                className="flex flex-wrap items-center gap-1.5"
                              />
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {/* D17: the people who are at the event but have no conversation
              yet, as quiet ghost rows at the list's foot rather than a
              standalone «Start conversation» button over a picker dialog. The
              row *is* the candidate, so «Start» appears where the conversation
              would — on them, on hover or keyboard focus. The backend still
              re-checks eligibility (opt-in, phone) and refuses if it does not
              hold. */}
          {startCandidates.length > 0 ? (
            <section aria-labelledby={notStartedId}>
              <h3
                id={notStartedId}
                className="sticky top-0 z-10 flex items-center gap-2 border-y border-l-[3px] border-border-strong border-l-transparent bg-surface-sunken py-2 pr-4 pl-3.5 jts-overline text-ink-muted"
              >
                <UserRoundPlus
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">Not started</span>
                <span className="shrink-0 tabular-nums tracking-normal">
                  {startCandidates.length}
                </span>
              </h3>
              <ul>
                {startCandidates.map((candidate) => (
                  <li
                    key={candidate.participantId}
                    className="group border-b border-border-subtle last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-2 px-4 py-2">
                      <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-semibold break-words text-ink-muted">
                        {candidate.label}
                      </p>
                      {/* Hidden until the row is hovered or holds focus. The
                          button stays in the DOM throughout, so keyboard and
                          screen-reader users reach it without a mouse. */}
                      <div className="shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <ConfirmAction
                          label="Start"
                          heading="Start a conversation"
                          description={
                            <>
                              Opens a feedback conversation with{" "}
                              {candidate.label} and queues their intro message.
                            </>
                          }
                          confirmLabel="Start conversation"
                          isPending={startPending}
                          isDisabled={startDisabled || startPending}
                          onConfirm={() =>
                            onStartConversation(candidate.participantId)
                          }
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
