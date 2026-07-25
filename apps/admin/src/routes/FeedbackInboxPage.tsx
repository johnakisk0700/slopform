import { toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { PauseCircle, PlayCircle, SquareX } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import {
  getGetFeedbackCampaignQueryKey,
  useCloseFeedbackCampaign,
  usePauseFeedbackCampaign,
  useResumeFeedbackCampaign,
  useStartFeedbackConversation,
} from "../api/generated/feedback-campaigns";
import {
  getGetFeedbackConversationQueryKey,
  getListFeedbackCampaignConversationsQueryKey,
  getListFeedbackConversationResultsQueryKey,
  useCloseFeedbackConversation,
  useGetFeedbackConversation,
  useListFeedbackCampaignConversations,
  useListFeedbackConversationResults,
  useResumeFeedbackConversationBot,
  useSendFeedbackConversationStaffMessage,
  useTakeOverFeedbackConversation,
} from "../api/generated/feedback-conversations";
import { useUpdateFeedbackNoteReviewStatus } from "../api/generated/feedback-notes";
import type { FeedbackConversationDetailDtoOutput } from "../api/generated/model/feedbackConversationDetailDtoOutput";
import { ConfirmAction } from "../components/admin/feedback/ConfirmAction";
import { ConversationDetails } from "../components/admin/feedback/ConversationDetails";
import { ConversationList } from "../components/admin/feedback/ConversationList";
import {
  ConversationTranscript,
  ConversationTranscriptEmpty,
} from "../components/admin/feedback/ConversationTranscript";
import { FeedbackBadges } from "../components/admin/feedback/FeedbackBadges";
import { StartConversationAction } from "../components/admin/feedback/StartConversationAction";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  matchesConversationQuery,
  resolveSelectedConversationId,
  sortConversationsForInbox,
} from "../features/feedback/conversationView";
import { campaignStatusBadge } from "../features/feedback/labels";
import {
  CONVERSATION_LIST_POLL_INTERVAL_MS,
  RESULTS_POLL_INTERVAL_MS,
  conversationPollInterval,
} from "../features/feedback/polling";
import {
  useFeedbackSimulatorThread,
  useInjectFeedbackSimulatorMessage,
} from "../lib/feedbackSimulator";
import { usePageMeta } from "../lib/usePageMeta";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : fallback;
}

type ConversationAction = "take-over" | "resume-bot" | "close";

/**
 * The post-event feedback inbox: one campaign's conversations in the
 * three-pane helpdesk layout (U1).
 *
 * The campaign id comes from the route because every backend operation on this
 * screen is campaign-scoped, and selection lives in `?conversation=` so a
 * thread can be linked to, reloaded and stepped back through without losing
 * the list beside it. Polling (U3) keeps the list and the open thread current;
 * TanStack Query pauses those intervals on its own while the tab is hidden.
 */
export function FeedbackInboxPage() {
  const { campaignId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ConversationAction | null>(
    null,
  );

  usePageMeta(
    "Feedback conversations",
    "Read and steer post-event feedback conversations for one campaign.",
  );

  const listQuery = useListFeedbackCampaignConversations(campaignId, {
    query: {
      enabled: campaignId !== "",
      refetchInterval: CONVERSATION_LIST_POLL_INTERVAL_MS,
      // The inbox is a live surface: coming back to the tab should show the
      // current state immediately rather than at the next interval tick.
      refetchOnWindowFocus: true,
    },
  });

  const campaign = listQuery.data?.campaign;
  const conversations = useMemo(
    () => listQuery.data?.conversations ?? [],
    [listQuery.data?.conversations],
  );

  const visible = useMemo(
    () =>
      sortConversationsForInbox(
        conversations.filter((row) => matchesConversationQuery(row, query)),
      ),
    [conversations, query],
  );

  const requestedId = searchParams.get("conversation");
  const selectedId = resolveSelectedConversationId(visible, requestedId);
  const selectedRow = useMemo(
    () => visible.find((row) => row.id === selectedId),
    [visible, selectedId],
  );

  function selectConversation(conversationId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("conversation", conversationId);
    setSearchParams(next, { replace: true });
    setActionError(null);
  }

  const detailQuery = useGetFeedbackConversation(campaignId, selectedId ?? "", {
    query: {
      enabled: campaignId !== "" && selectedId !== null,
      // A closed thread has no pending transition left to watch, so the list
      // row's lifecycle decides whether the fast timer runs at all.
      refetchInterval: conversationPollInterval(selectedRow),
      refetchOnWindowFocus: true,
    },
  });

  const resultsQuery = useListFeedbackConversationResults(
    campaignId,
    selectedId ?? "",
    {
      query: {
        enabled: campaignId !== "" && selectedId !== null,
        refetchInterval: RESULTS_POLL_INTERVAL_MS,
      },
    },
  );

  const conversation = detailQuery.data;

  // U2: the simulator answers only where it is mounted, so a successful thread
  // read is what tells this screen the transport is simulated.
  const simulatorThread = useFeedbackSimulatorThread(
    conversation?.phoneAtLaunch,
  );
  const injectSimulatorMessage = useInjectFeedbackSimulatorMessage();
  const simulatorAvailable = simulatorThread.isSuccess;

  const takeOver = useTakeOverFeedbackConversation();
  const resumeBot = useResumeFeedbackConversationBot();
  const closeConversation = useCloseFeedbackConversation();
  const sendStaffMessage = useSendFeedbackConversationStaffMessage();
  const updateNoteReviewStatus = useUpdateFeedbackNoteReviewStatus();
  const startConversation = useStartFeedbackConversation();
  const pauseCampaign = usePauseFeedbackCampaign();
  const resumeCampaign = useResumeFeedbackCampaign();
  const closeCampaign = useCloseFeedbackCampaign();

  function invalidateCampaign() {
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListFeedbackCampaignConversationsQueryKey(campaignId),
      }),
      queryClient.invalidateQueries({
        queryKey: getGetFeedbackCampaignQueryKey(campaignId),
      }),
    ]);
  }

  /**
   * Every conversation action answers with the updated read model, so the
   * cache is corrected from the server's own response before anything is
   * refetched — no optimistic guess about capabilities can be wrong here.
   */
  function applyConversationResult(
    updated: FeedbackConversationDetailDtoOutput,
  ) {
    queryClient.setQueryData(
      getGetFeedbackConversationQueryKey(campaignId, updated.id),
      updated,
    );
    return invalidateCampaign();
  }

  async function runConversationAction(
    action: ConversationAction,
    run: () => Promise<FeedbackConversationDetailDtoOutput>,
    failure: string,
  ) {
    setActionError(null);
    setPendingAction(action);
    try {
      await applyConversationResult(await run());
    } catch (cause) {
      setActionError(errorMessage(cause, failure));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleStaffSend(text: string) {
    setActionError(null);
    if (selectedId === null) {
      return;
    }
    try {
      const updated = await sendStaffMessage.mutateAsync({
        campaignId,
        conversationId: selectedId,
        data: { text },
      });
      await applyConversationResult(updated);
    } catch (cause) {
      setActionError(errorMessage(cause, "The message could not be queued."));
    }
  }

  async function handleSimulatedReply(text: string) {
    setActionError(null);
    if (conversation === undefined) {
      return;
    }
    try {
      await injectSimulatorMessage.mutateAsync({
        phoneE164: conversation.phoneAtLaunch,
        text,
      });
      await Promise.all([detailQuery.refetch(), resultsQuery.refetch()]);
      await invalidateCampaign();
    } catch (cause) {
      setActionError(
        errorMessage(cause, "The simulated message could not be injected."),
      );
    }
  }

  async function handleNoteReviewChange(
    noteId: string,
    status: "new" | "dismissed",
  ) {
    setActionError(null);
    try {
      await updateNoteReviewStatus.mutateAsync({ noteId, data: { status } });
      await queryClient.invalidateQueries({
        queryKey: getListFeedbackConversationResultsQueryKey(
          campaignId,
          selectedId ?? "",
        ),
      });
    } catch (cause) {
      setActionError(errorMessage(cause, "The note could not be updated."));
    }
  }

  async function handleStartConversation(participantId: string) {
    setActionError(null);
    try {
      const result = await startConversation.mutateAsync({
        campaignId,
        data: { participantId },
      });
      await invalidateCampaign();
      selectConversation(result.conversationId);
      toast.success(
        result.created ? "Conversation started" : "Conversation already open",
        {
          description: result.introEnqueued
            ? "The intro message is queued for delivery."
            : "No intro was queued for this conversation.",
        },
      );
    } catch (cause) {
      setActionError(
        errorMessage(cause, "The conversation could not be started."),
      );
    }
  }

  async function runCampaignAction(
    run: () => Promise<unknown>,
    failure: string,
    success: string,
  ) {
    setActionError(null);
    try {
      await run();
      await invalidateCampaign();
      toast.success(success);
    } catch (cause) {
      setActionError(errorMessage(cause, failure));
    }
  }

  const existingParticipantIds = useMemo(
    () => new Set(conversations.map((row) => row.respondentParticipantId)),
    [conversations],
  );

  const listError = listQuery.isError
    ? errorMessage(listQuery.error, "Failed to load conversations.")
    : null;

  if (campaignId === "") {
    return (
      <p role="alert" className="text-sm text-danger">
        No campaign was given.
      </p>
    );
  }

  const campaignBusy =
    pauseCampaign.isPending ||
    resumeCampaign.isPending ||
    closeCampaign.isPending;

  return (
    <div className="flex flex-col gap-5">
      <JtsPageHeader
        eyebrow="Post-event feedback"
        title={campaign?.eventTitle ?? "Feedback conversations"}
        description="Read every conversation for this campaign, take one over when it needs a person, and hand it back when it does not."
        actions={
          <>
            <Link
              to="/admin/feedback"
              className="self-center text-sm font-semibold text-primary"
            >
              All campaigns
            </Link>
            {campaign ? (
              <Link
                to={`/admin/feedback/${campaign.id}/results`}
                className="self-center text-sm font-semibold text-primary"
              >
                Results
              </Link>
            ) : null}

            {campaign ? (
              <StartConversationAction
                eventId={campaign.eventId}
                existingParticipantIds={existingParticipantIds}
                isDisabled={campaign.status === "closed"}
                isPending={startConversation.isPending}
                onStart={handleStartConversation}
              />
            ) : null}

            {campaign?.status === "launched" ? (
              <ConfirmAction
                label="Pause campaign"
                icon={<PauseCircle aria-hidden="true" className="size-4" />}
                heading="Pause this campaign"
                description="Queued messages stop going out until you resume. Conversations already open stay open, and replies still arrive."
                confirmLabel="Pause campaign"
                isPending={pauseCampaign.isPending}
                isDisabled={campaignBusy}
                onConfirm={() =>
                  runCampaignAction(
                    () => pauseCampaign.mutateAsync({ campaignId }),
                    "The campaign could not be paused.",
                    "Campaign paused",
                  )
                }
              />
            ) : null}

            {campaign?.status === "paused" ? (
              <ConfirmAction
                label="Resume campaign"
                icon={<PlayCircle aria-hidden="true" className="size-4" />}
                heading="Resume this campaign"
                description="Queued messages start going out again, including anything held while the campaign was paused."
                confirmLabel="Resume campaign"
                isPending={resumeCampaign.isPending}
                isDisabled={campaignBusy}
                onConfirm={() =>
                  runCampaignAction(
                    () => resumeCampaign.mutateAsync({ campaignId }),
                    "The campaign could not be resumed.",
                    "Campaign resumed",
                  )
                }
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
                isPending={closeCampaign.isPending}
                isDisabled={campaignBusy}
                onConfirm={() =>
                  runCampaignAction(
                    () => closeCampaign.mutateAsync({ campaignId }),
                    "The campaign could not be closed.",
                    "Campaign closed",
                  )
                }
              />
            ) : null}
          </>
        }
      />

      {campaign ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-surface px-4 py-3">
          <FeedbackBadges badges={[campaignStatusBadge(campaign.status)]} />
          <p className="text-sm text-ink-muted">
            <strong className="font-bold text-ink tabular-nums">
              {campaign.conversationCount}
            </strong>{" "}
            conversations
          </p>
          <p className="text-sm text-ink-muted">
            <strong className="font-bold text-ink tabular-nums">
              {campaign.openCount}
            </strong>{" "}
            open
          </p>
          <p className="text-sm text-ink-muted">
            <strong className="font-bold text-ink tabular-nums">
              {campaign.needsAttentionCount}
            </strong>{" "}
            need attention
          </p>
          {simulatorAvailable ? (
            <p className="text-[0.65rem] font-extrabold uppercase tracking-caps text-warning">
              Simulated transport
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Each pane is its own scroll container capped to the viewport, so
          switching conversations never costs an operator their place in the
          list — and the shell's ordinary page scroll keeps working. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)_minmax(17rem,21rem)]">
        <div className="min-h-0 lg:row-span-2 2xl:row-span-1">
          <ConversationList
            conversations={visible}
            selectedId={selectedId}
            query={query}
            onQueryChange={setQuery}
            onSelect={selectConversation}
            loading={listQuery.isPending}
            error={listError}
            totalCount={conversations.length}
          />
        </div>

        <div className="min-h-0">
          {conversation ? (
            <ConversationTranscript
              conversation={conversation}
              onStaffSend={handleStaffSend}
              staffSendPending={sendStaffMessage.isPending}
              {...(simulatorAvailable
                ? {
                    onSimulatedReply: handleSimulatedReply,
                    simulatedReplyPending: injectSimulatorMessage.isPending,
                  }
                : {})}
              actionError={actionError}
            />
          ) : detailQuery.isError ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(detailQuery.error, "Failed to load conversation.")}
            </p>
          ) : detailQuery.isPending && selectedId !== null ? (
            <p role="status" className="text-sm text-ink-muted">
              Loading conversation…
            </p>
          ) : (
            <ConversationTranscriptEmpty />
          )}
        </div>

        <div className="min-h-0">
          {conversation ? (
            <ConversationDetails
              conversation={conversation}
              results={resultsQuery.data}
              resultsLoading={resultsQuery.isPending}
              resultsError={
                resultsQuery.isError
                  ? errorMessage(resultsQuery.error, "Failed to load answers.")
                  : null
              }
              onTakeOver={() =>
                runConversationAction(
                  "take-over",
                  () =>
                    takeOver.mutateAsync({
                      campaignId,
                      conversationId: conversation.id,
                    }),
                  "The conversation could not be taken over.",
                )
              }
              onResumeBot={() =>
                runConversationAction(
                  "resume-bot",
                  () =>
                    resumeBot.mutateAsync({
                      campaignId,
                      conversationId: conversation.id,
                    }),
                  "The bot could not be resumed.",
                )
              }
              onClose={() =>
                runConversationAction(
                  "close",
                  () =>
                    closeConversation.mutateAsync({
                      campaignId,
                      conversationId: conversation.id,
                    }),
                  "The conversation could not be closed.",
                )
              }
              onNoteReviewChange={handleNoteReviewChange}
              pendingAction={pendingAction}
              noteUpdatePending={updateNoteReviewStatus.isPending}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
