import { toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { useGetEvent } from "../../api/generated/events";
import {
  getGetFeedbackCampaignQueryKey,
  useCloseFeedbackCampaign,
  usePauseFeedbackCampaign,
  useResumeFeedbackCampaign,
  useStartFeedbackConversation,
} from "../../api/generated/feedback-campaigns";
import {
  getGetFeedbackConversationQueryKey,
  getListFeedbackCampaignConversationsQueryKey,
  useCloseFeedbackConversation,
  useGetFeedbackConversation,
  useListFeedbackCampaignConversations,
  useListFeedbackConversationResults,
  useResolveFeedbackConversationAttentionReason,
  useResumeFeedbackConversationBot,
  useSendFeedbackConversationStaffMessage,
  useTakeOverFeedbackConversation,
} from "../../api/generated/feedback-conversations";
import type { FeedbackConversationDetailDtoOutput } from "../../api/generated/model/feedbackConversationDetailDtoOutput";
import { sortConversationsForInbox } from "../../features/feedback/conversationView";
import {
  CONVERSATION_LIST_POLL_INTERVAL_MS,
  RESULTS_POLL_INTERVAL_MS,
  conversationPollInterval,
} from "../../features/feedback/polling";
import { apiErrorMessage } from "../../lib/api";
import {
  useFeedbackSimulatorThread,
  useInjectFeedbackSimulatorMessage,
} from "../../lib/feedbackSimulator";

import { useConversationSelection } from "./useConversationSelection";
import { useFeedbackResultActions } from "./useFeedbackResultActions";

type ConversationAction = "take-over" | "resume-bot" | "close";
export function useFeedbackInboxControls() {
  const { campaignId = "" } = useParams();

  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<ConversationAction | null>(
    null,
  );

  const [dismissingReasonId, setDismissingReasonId] = useState<string | null>(
    null,
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

  const visible = useMemo(
    () => sortConversationsForInbox(listQuery.data?.conversations ?? []),
    [listQuery.data?.conversations],
  );
  const {
    selectedId,
    threadOpenOnNarrow,
    fullscreenOnNarrow,
    selectConversation,
    setConversationFullscreen,
  } = useConversationSelection(visible, setActionError);

  const selectedRow = useMemo(
    () => visible.find((row) => row.id === selectedId),
    [visible, selectedId],
  );

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

  const resolveAttentionReason =
    useResolveFeedbackConversationAttentionReason();
  const {
    updateNoteReviewStatus,
    addNote,
    correctAnswer,
    withdrawAnswer,
    addAnswer,
    handleAddNote,
    handleCorrectAnswer,
    handleAddAnswer,
    handleWithdrawAnswer,
    handleNoteReviewChange,
  } = useFeedbackResultActions({ campaignId, selectedId, setActionError });

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

  async function handleStaffSend(
    text: string,
    clientMessageId: string,
  ): Promise<boolean> {
    setActionError(null);
    if (selectedId === null) {
      return false;
    }
    try {
      const updated = await sendStaffMessage.mutateAsync({
        campaignId,
        conversationId: selectedId,
        data: { clientMessageId, text },
      });
      await applyConversationResult(updated);
      return true;
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "The message could not be queued."),
      );
      return false;
    }
  }

  async function handleSimulatedReply(
    text: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    setActionError(null);
    if (conversation === undefined) {
      return false;
    }
    try {
      await injectSimulatorMessage.mutateAsync({
        phoneE164: conversation.phoneAtLaunch,
        text,
        idempotencyKey,
      });
      await Promise.all([detailQuery.refetch(), resultsQuery.refetch()]);
      await invalidateCampaign();
      return true;
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "The simulated message could not be injected."),
      );
      return false;
    }
  }

  /**
   * Clears one attention reason, straight from the press. The response is the
   * updated conversation, so the row goes and — when that was the last
   * unresolved reason — the inbox badge with it, without waiting for a poll.
   */
  async function handleDismissAttentionReason(reasonId: string) {
    setActionError(null);
    if (selectedId === null) {
      return;
    }
    setDismissingReasonId(reasonId);
    try {
      const updated = await resolveAttentionReason.mutateAsync({
        campaignId,
        conversationId: selectedId,
        reasonId,
      });
      await applyConversationResult(updated);
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "The reason could not be dismissed."),
      );
    } finally {
      setDismissingReasonId(null);
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

  // D17 candidates for the list's NOT STARTED group: attendees marked present
  // with no conversation yet. Read from the event's own attendee list — the
  // backend re-checks eligibility on start, so this is display, not the rule.
  const eventQuery = useGetEvent(campaign?.eventId ?? "", {
    query: {
      enabled: campaign !== undefined,
      refetchOnWindowFocus: true,
    },
  });

  const startCandidates = useMemo(() => {
    const existingParticipantIds = new Set(
      visible.map((row) => row.respondentParticipantId),
    );
    const attendees = eventQuery.data?.attendees ?? [];
    return attendees
      .filter(
        (attendee) =>
          attendee.present &&
          !existingParticipantIds.has(attendee.participantId),
      )
      .map((attendee) => ({
        participantId: attendee.participantId,
        label: attendee.preferredName ?? attendee.emailNormalized,
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "el"));
  }, [eventQuery.data?.attendees, visible]);

  const listError = listQuery.isError
    ? apiErrorMessage(listQuery.error, "Failed to load conversations.")
    : null;
  return {
    campaignId,
    actionError,
    pendingAction,
    dismissingReasonId,
    listQuery,
    campaign,
    visible,
    selectedId,
    threadOpenOnNarrow,
    fullscreenOnNarrow,
    selectConversation,
    setConversationFullscreen,
    detailQuery,
    resultsQuery,
    conversation,
    injectSimulatorMessage,
    simulatorAvailable,
    takeOver,
    resumeBot,
    closeConversation,
    sendStaffMessage,
    updateNoteReviewStatus,
    addNote,
    correctAnswer,
    withdrawAnswer,
    addAnswer,
    startConversation,
    pauseCampaign,
    resumeCampaign,
    closeCampaign,
    runConversationAction,
    handleStaffSend,
    handleSimulatedReply,
    handleAddNote,
    handleCorrectAnswer,
    handleAddAnswer,
    handleWithdrawAnswer,
    handleDismissAttentionReason,
    handleNoteReviewChange,
    handleStartConversation,
    runCampaignAction,
    eventQuery,
    startCandidates,
    listError,
  };
}
