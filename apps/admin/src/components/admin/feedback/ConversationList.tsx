import { Input } from "@heroui/react";
import { clsx } from "clsx";
import { Inbox, MessageSquareDashed, Search, SearchX } from "lucide-react";
import { useId, type ReactNode } from "react";

import {
  conversationBadges,
  formatTimestamp,
  goalProgress,
  groupConversations,
  type ConversationListItem,
} from "../../../features/feedback/conversationView";
import {
  isUnresolvedParticipant,
  participantLabel,
} from "../../../features/feedback/labels";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { FeedbackBadges } from "./FeedbackBadges";

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
   * The D17 «Start conversation» trigger. It belongs beside this list because
   * that is where the conversation it creates appears.
   */
  startAction?: ReactNode;
}

/**
 * The inbox column: a text filter over one campaign's conversations, grouped
 * into the buckets an operator triages by (attention, open, closed).
 *
 * Choosing a row swaps the panes beside it rather than navigating, which is
 * what keeps a helpdesk operator's place while several threads move at once.
 * The selected row carries `aria-current`, and goal progress is announced as
 * text with the bar left decorative — a `<button>` may not contain the
 * `div`-based HeroUI `ProgressBar`, and the count already says everything the
 * bar does.
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
  startAction,
}: ConversationListProps) {
  const filterId = useId();
  const headingId = useId();

  const groups = groupConversations(conversations);

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-[78vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2
            id={headingId}
            className="flex items-center gap-2 text-[0.7rem] font-extrabold uppercase tracking-caps text-ink-muted"
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
            className="w-full pl-9"
          />
        </div>
        {startAction ? <div className="mt-2.5">{startAction}</div> : null}
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

      {conversations.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.title}>
              <h3 className="sticky top-0 z-10 border-y border-border bg-surface-sunken px-4 py-1.5 text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
                {group.title}
                <span className="ml-1.5 font-bold tabular-nums opacity-70">
                  {group.conversations.length}
                </span>
              </h3>
              <ul>
                {group.conversations.map((conversation) => {
                  const isSelected = conversation.id === selectedId;
                  const progress = goalProgress(conversation.goals);
                  const name = participantLabel(
                    conversation.respondentDisplayName,
                  );
                  const unresolved = isUnresolvedParticipant(
                    conversation.respondentDisplayName,
                  );
                  const settled = progress.answered + progress.skipped;

                  return (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        {...(isSelected ? { "aria-current": true } : {})}
                        onClick={() => onSelect(conversation.id)}
                        className={clsx(
                          "block w-full cursor-pointer border-b border-border-subtle px-4 py-3 text-left transition-colors",
                          isSelected
                            ? "bg-primary-soft"
                            : "hover:bg-surface-sunken",
                        )}
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span
                            className={clsx(
                              "truncate text-sm font-bold",
                              isSelected ? "text-primary" : "text-ink",
                              unresolved && "italic",
                            )}
                          >
                            {name}
                          </span>
                          {/* ink-muted, not ink-subtle: the selected row sits on
                              primary-soft, where subtle drops under AA. */}
                          <span className="shrink-0 text-[0.7rem] font-semibold tabular-nums text-ink-muted">
                            {conversation.lastMessageAt === null
                              ? "—"
                              : formatTimestamp(conversation.lastMessageAt)}
                          </span>
                        </span>

                        <span className="mt-0.5 block truncate text-xs text-ink-muted">
                          {conversation.phoneAtLaunch}
                        </span>

                        <span className="mt-2 flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunken"
                          >
                            <span
                              className="block h-full rounded-full bg-primary"
                              style={{ width: `${progress.percent}%` }}
                            />
                          </span>
                          <span className="shrink-0 text-[0.7rem] font-bold tabular-nums text-ink-muted">
                            {settled}/{progress.total} answered
                          </span>
                        </span>

                        <FeedbackBadges
                          badges={conversationBadges(conversation)}
                          className="mt-2 flex flex-wrap items-center gap-1.5"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}
