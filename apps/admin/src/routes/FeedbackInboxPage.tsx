import { toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";

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
  getListFeedbackCampaignResultsQueryKey,
  getListFeedbackConversationResultsQueryKey,
  useAddFeedbackConversationNote,
  useCloseFeedbackConversation,
  useGetFeedbackConversation,
  useListFeedbackCampaignConversations,
  useListFeedbackConversationResults,
  useResumeFeedbackConversationBot,
  useSendFeedbackConversationStaffMessage,
  useTakeOverFeedbackConversation,
} from "../api/generated/feedback-conversations";
import { useUpdateFeedbackNoteReviewStatus } from "../api/generated/feedback-notes";
import type { AddFeedbackConversationNoteDtoNoteType } from "../api/generated/model/addFeedbackConversationNoteDtoNoteType";
import type { FeedbackConversationDetailDtoOutput } from "../api/generated/model/feedbackConversationDetailDtoOutput";
import { CampaignHeader } from "../components/admin/feedback/CampaignHeader";
import {
  ConversationActions,
  NotesPanel,
  ProgressPanel,
  RespondentPanel,
} from "../components/admin/feedback/ConversationDetails";
import { ConversationList } from "../components/admin/feedback/ConversationList";
import {
  ConversationTranscript,
  ConversationTranscriptEmpty,
} from "../components/admin/feedback/ConversationTranscript";
import { StartConversationAction } from "../components/admin/feedback/StartConversationAction";
import {
  matchesConversationQuery,
  resolveSelectedConversationId,
  sortConversationsForInbox,
} from "../features/feedback/conversationView";
import {
  CONVERSATION_LIST_POLL_INTERVAL_MS,
  RESULTS_POLL_INTERVAL_MS,
  conversationPollInterval,
} from "../features/feedback/polling";
import { apiErrorMessage } from "../lib/api";
import {
  useFeedbackSimulatorThread,
  useInjectFeedbackSimulatorMessage,
} from "../lib/feedbackSimulator";
import { usePageMeta } from "../lib/usePageMeta";

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
  const addNote = useAddFeedbackConversationNote();
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
      setActionError(apiErrorMessage(cause, failure));
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
      setActionError(
        apiErrorMessage(cause, "The message could not be queued."),
      );
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
        apiErrorMessage(cause, "The simulated message could not be injected."),
      );
    }
  }

  /**
   * Writes a staff note and refreshes both places notes are read: this
   * conversation's results and the campaign-wide Results tab. It deliberately
   * does not catch — the dialog surfaces the failure in its own context, where
   * the operator's text is still on screen.
   */
  async function handleAddNote(
    conversationId: string,
    input: {
      noteType: AddFeedbackConversationNoteDtoNoteType;
      text: string;
      subjectParticipantId?: string;
    },
  ) {
    setActionError(null);
    await addNote.mutateAsync({ campaignId, conversationId, data: input });
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListFeedbackConversationResultsQueryKey(
          campaignId,
          conversationId,
        ),
      }),
      queryClient.invalidateQueries({
        queryKey: getListFeedbackCampaignResultsQueryKey(campaignId),
      }),
    ]);
    toast.success("Note added", {
      description: "It is saved as a staff note and labelled as one.",
    });
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
      setActionError(apiErrorMessage(cause, "The note could not be updated."));
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
        apiErrorMessage(cause, "The conversation could not be started."),
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
      setActionError(apiErrorMessage(cause, failure));
    }
  }

  const existingParticipantIds = useMemo(
    () => new Set(conversations.map((row) => row.respondentParticipantId)),
    [conversations],
  );

  const listError = listQuery.isError
    ? apiErrorMessage(listQuery.error, "Failed to load conversations.")
    : null;

  if (campaignId === "") {
    return (
      <p role="alert" className="text-sm text-danger">
        No campaign was given.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <CampaignHeader
        campaign={campaign}
        simulatorAvailable={simulatorAvailable}
        pausePending={pauseCampaign.isPending}
        resumePending={resumeCampaign.isPending}
        closePending={closeCampaign.isPending}
        onPause={() =>
          runCampaignAction(
            () => pauseCampaign.mutateAsync({ campaignId }),
            "The campaign could not be paused.",
            "Campaign paused",
          )
        }
        onResume={() =>
          runCampaignAction(
            () => resumeCampaign.mutateAsync({ campaignId }),
            "The campaign could not be resumed.",
            "Campaign resumed",
          )
        }
        onClose={() =>
          runCampaignAction(
            () => closeCampaign.mutateAsync({ campaignId }),
            "The campaign could not be closed.",
            "Campaign closed",
          )
        }
      />

      {/* Two panes on top — triage beside the thread — and the conversation's
          detail broken into a strip of small cards under them. Each pane is
          its own scroll container capped to the viewport, so switching
          conversations never costs an operator their place in the list, and no
          single column has to carry every fact about the conversation. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
        <div className="min-h-0">
          <ConversationList
            conversations={visible}
            selectedId={selectedId}
            query={query}
            onQueryChange={setQuery}
            onSelect={selectConversation}
            loading={listQuery.isPending}
            error={listError}
            totalCount={conversations.length}
            isRefreshing={listQuery.isFetching}
            {...(campaign
              ? {
                  startAction: (
                    <StartConversationAction
                      eventId={campaign.eventId}
                      existingParticipantIds={existingParticipantIds}
                      isDisabled={campaign.status === "closed"}
                      isPending={startConversation.isPending}
                      onStart={handleStartConversation}
                    />
                  ),
                }
              : {})}
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
              isRefreshing={detailQuery.isFetching}
              actions={
                <ConversationActions
                  conversation={conversation}
                  pendingAction={pendingAction}
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
                />
              }
            />
          ) : detailQuery.isError ? (
            <p role="alert" className="text-sm text-danger">
              {apiErrorMessage(
                detailQuery.error,
                "Failed to load conversation.",
              )}
            </p>
          ) : detailQuery.isPending && selectedId !== null ? (
            <p role="status" className="text-sm text-ink-muted">
              Loading conversation…
            </p>
          ) : (
            <ConversationTranscriptEmpty />
          )}
        </div>

        {/* The detail strip: what the conversation produced, what staff wrote
            about it, and who it is with — three short cards side by side
            instead of one column an operator has to scroll to reach the
            notes. */}
        {conversation ? (
          <div className="grid gap-4 md:grid-cols-2 lg:col-span-2 xl:grid-cols-3">
            <ProgressPanel
              conversation={conversation}
              results={resultsQuery.data}
              resultsLoading={resultsQuery.isPending}
              resultsError={
                resultsQuery.isError
                  ? apiErrorMessage(
                      resultsQuery.error,
                      "Failed to load answers.",
                    )
                  : null
              }
            />
            <NotesPanel
              conversation={conversation}
              eventId={campaign?.eventId ?? ""}
              results={resultsQuery.data}
              onNoteReviewChange={handleNoteReviewChange}
              onAddNote={(input) => handleAddNote(conversation.id, input)}
              noteUpdatePending={updateNoteReviewStatus.isPending}
              addNotePending={addNote.isPending}
            />
            <RespondentPanel conversation={conversation} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
