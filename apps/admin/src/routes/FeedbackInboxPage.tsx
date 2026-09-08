import { Button, toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Maximize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useCorrectFeedbackConversationAnswer,
  useGetFeedbackConversation,
  useListFeedbackCampaignConversations,
  useListFeedbackConversationResults,
  useResolveFeedbackConversationAttentionReason,
  useResumeFeedbackConversationBot,
  useSendFeedbackConversationStaffMessage,
  useTakeOverFeedbackConversation,
  useAddFeedbackConversationAnswer,
  useWithdrawFeedbackConversationAnswer,
} from "../api/generated/feedback-conversations";
import { useGetEvent } from "../api/generated/events";
import { useUpdateFeedbackNoteReviewStatus } from "../api/generated/feedback-notes";
import type { AddFeedbackConversationNoteDtoNoteType } from "../api/generated/model/addFeedbackConversationNoteDtoNoteType";
import type { DirectedQuestionKey } from "../features/feedback/directedAnswers";
import type { FeedbackConversationDetailDtoOutput } from "../api/generated/model/feedbackConversationDetailDtoOutput";
import {
  CampaignContext,
  CampaignHeader,
} from "../components/admin/feedback/CampaignHeader";
import { CampaignSummary } from "../components/admin/feedback/CampaignSummary";
import { ConversationAttention } from "../components/admin/feedback/ConversationAttention";
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
import {
  hasExplicitConversationSelection,
  resolveSelectedConversationId,
  sortConversationsForInbox,
} from "../features/feedback/conversationView";
import {
  CONVERSATION_LIST_POLL_INTERVAL_MS,
  RESULTS_POLL_INTERVAL_MS,
  conversationPollInterval,
} from "../features/feedback/polling";
import { JtsBackLink } from "../components/ui/JtsBackLink";
import { apiErrorMessage } from "../lib/api";
import {
  useFeedbackSimulatorThread,
  useInjectFeedbackSimulatorMessage,
} from "../lib/feedbackSimulator";
import { usePageMeta } from "../lib/usePageMeta";

type ConversationAction = "take-over" | "resume-bot" | "close";

/** Campaign inbox with URL selection and polling of the active conversation. */
export function FeedbackInboxPage() {
  const { campaignId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ConversationAction | null>(
    null,
  );
  const [dismissingReasonId, setDismissingReasonId] = useState<string | null>(
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
  const visible = useMemo(
    () => sortConversationsForInbox(listQuery.data?.conversations ?? []),
    [listQuery.data?.conversations],
  );

  const requestedId = searchParams.get("conversation");
  // Keep desktop auto-selection stable across polls without opening mobile detail.
  const stickySelectedRef = useRef<string | null>(null);
  const selectedId = resolveSelectedConversationId(
    visible,
    requestedId,
    stickySelectedRef.current,
  );
  stickySelectedRef.current = selectedId;

  // Only a valid explicit URL selection opens the narrow detail view.
  const threadOpenOnNarrow = hasExplicitConversationSelection(
    requestedId,
    selectedId,
  );
  // Push the cover on open; replace on close so Back exits it before the thread.
  const fullscreenOnNarrow =
    threadOpenOnNarrow && searchParams.get("fullscreen") === "1";
  const selectedRow = useMemo(
    () => visible.find((row) => row.id === selectedId),
    [visible, selectedId],
  );

  function selectConversation(conversationId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("conversation", conversationId);
    next.delete("fullscreen");
    // Opening the *first* thread is a step into a detail view — on a phone the
    // whole screen changes, so the back gesture has to undo it. Switching
    // between threads is not a step: that replaces, or an operator clicking
    // down the list on a wide screen buries the way out under ten entries.
    setSearchParams(next, { replace: threadOpenOnNarrow });
    setActionError(null);
  }

  const setConversationFullscreen = useCallback(
    (open: boolean) => {
      const next = new URLSearchParams(searchParams);
      if ((next.get("fullscreen") === "1") === open) {
        return;
      }
      if (open) {
        next.set("fullscreen", "1");
      } else {
        next.delete("fullscreen");
      }
      setSearchParams(next, { replace: !open });
    },
    [searchParams, setSearchParams],
  );

  // The cover is a phone affordance. A wide layout with `?fullscreen=1` left
  // in the URL (rotate, paste) must not keep a scroll-locked fixed pane.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");
    function dropFullscreenOnDesktop() {
      if (desktop.matches) {
        setConversationFullscreen(false);
      }
    }
    dropFullscreenOnDesktop();
    desktop.addEventListener("change", dropFullscreenOnDesktop);
    return () => desktop.removeEventListener("change", dropFullscreenOnDesktop);
  }, [setConversationFullscreen]);

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
  const updateNoteReviewStatus = useUpdateFeedbackNoteReviewStatus();
  const addNote = useAddFeedbackConversationNote();
  const correctAnswer = useCorrectFeedbackConversationAnswer();
  const withdrawAnswer = useWithdrawFeedbackConversationAnswer();
  const addAnswer = useAddFeedbackConversationAnswer();
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
    await invalidateResults(conversationId);
    toast.success("Note added", {
      description: "It is saved as a staff note and labelled as one.",
    });
  }

  /**
   * Re-reads both places answers are shown after one has changed: this
   * conversation's results and the campaign-wide Results tab.
   */
  function invalidateResults(conversationId: string) {
    return Promise.all([
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
  }

  /**
   * Corrects one recorded score. It deliberately does not catch: the answer's
   * own row reports the failure, which is where the operator is looking and
   * where the value they tried to save still is.
   */
  async function handleCorrectAnswer(answerId: string, valueInt: number) {
    setActionError(null);
    if (selectedId === null) {
      return;
    }
    await correctAnswer.mutateAsync({
      campaignId,
      conversationId: selectedId,
      answerId,
      data: { valueInt },
    });
    await invalidateResults(selectedId);
    toast.success("Answer corrected", {
      description: "The recorded value is yours now, and says so.",
    });
  }

  /**
   * Records an answer an operator knows and the thread never heard. It
   * deliberately does not catch: the dialog keeps the operator's chosen person
   * on screen and reports the reason there.
   */
  async function handleAddAnswer(
    questionKey: DirectedQuestionKey,
    subjectParticipantId: string,
  ) {
    setActionError(null);
    if (selectedId === null) {
      return;
    }
    await addAnswer.mutateAsync({
      campaignId,
      conversationId: selectedId,
      data: { questionKey, subjectParticipantId },
    });
    await invalidateResults(selectedId);
    toast.success("Answer recorded", {
      description: "It is saved as your own answer and labelled as one.",
    });
  }

  /** Withdraws one answer recorded about the wrong person. */
  async function handleWithdrawAnswer(answerId: string) {
    setActionError(null);
    if (selectedId === null) {
      return;
    }
    await withdrawAnswer.mutateAsync({
      campaignId,
      conversationId: selectedId,
      answerId,
    });
    await invalidateResults(selectedId);
    toast.success("Answer withdrawn", {
      description: "It is off the record and no longer counts for anyone.",
    });
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

  if (campaignId === "") {
    return (
      <p role="alert" className="text-sm text-danger">
        No campaign was given.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        {/* Hide campaign chrome while the narrow screen shows a conversation. */}
        <div
          className={
            threadOpenOnNarrow
              ? "hidden lg:flex lg:flex-col lg:gap-3"
              : "flex flex-col gap-3"
          }
        >
          <CampaignHeader
            campaign={campaign}
            pausePending={pauseCampaign.isPending}
            resumePending={resumeCampaign.isPending}
            closePending={closeCampaign.isPending}
            simulatorAvailable={simulatorAvailable}
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

          <CampaignContext
            campaign={campaign}
            venue={eventQuery.data?.venue ?? null}
          />
        </div>

        {threadOpenOnNarrow ? (
          <div className="flex items-center justify-between gap-1 lg:hidden">
            <JtsBackLink to={`/admin/feedback/${campaignId}`}>
              Back to conversations
            </JtsBackLink>
            {/* Navigation chrome, not the act cluster — keeps the cover
                control away from Take over / Close. Hidden once the cover is
                on; minimise lives in the transcript header then, and back
                clears `?fullscreen=1` first. */}
            {!fullscreenOnNarrow ? (
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                className="h-7 w-7 min-h-7 shrink-0"
                aria-label="Open conversation fullscreen"
                onPress={() => {
                  setConversationFullscreen(true);
                }}
              >
                <Maximize2 aria-hidden="true" className="size-4" />
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className={threadOpenOnNarrow ? "hidden lg:block" : undefined}>
          <CampaignSummary campaignId={campaignId} />
        </div>

        {/* The explicit zero-minimum base track and grid items are not
            decorative responsive classes. On a narrow SPA navigation the
            campaign data is already present for the first layout; the
            implicit `auto` track otherwise adopts the panes' ~371px
            min-content width and widens the document. A cold reload painted
            the empty state first and hid the bug. */}
        {/* `items-stretch` so the transcript can fill the row; the list column
            stays `self-start` so it does not grow a blank band under its last
            row when the thread is taller. */}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-4 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
          <div
            className={
              threadOpenOnNarrow
                ? "hidden min-h-0 min-w-0 lg:block lg:self-start"
                : "min-h-0 min-w-0 lg:self-start"
            }
          >
            <ConversationList
              conversations={visible}
              selectedId={selectedId}
              onSelect={selectConversation}
              loading={listQuery.isPending}
              error={listError}
              isRefreshing={listQuery.isFetching}
              startCandidates={startCandidates}
              onStartConversation={handleStartConversation}
              startPending={startConversation.isPending}
              startDisabled={
                campaign === undefined || campaign.status === "closed"
              }
            />
          </div>

          <div
            className={
              threadOpenOnNarrow
                ? "min-h-0 min-w-0"
                : "hidden min-h-0 min-w-0 lg:block"
            }
          >
            {conversation ? (
              <ConversationTranscript
                key={conversation.id}
                conversation={conversation}
                campaignStatus={campaign?.status ?? null}
                onStaffSend={handleStaffSend}
                staffSendPending={sendStaffMessage.isPending}
                isFullscreen={fullscreenOnNarrow}
                onFullscreenChange={setConversationFullscreen}
                {...(simulatorAvailable
                  ? {
                      onSimulatedReply: handleSimulatedReply,
                      simulatedReplyPending: injectSimulatorMessage.isPending,
                    }
                  : {})}
                actionError={actionError}
                isRefreshing={detailQuery.isFetching}
                attention={
                  <ConversationAttention
                    conversation={conversation}
                    dismissingReasonId={dismissingReasonId}
                    onDismiss={handleDismissAttentionReason}
                  />
                }
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
                    onClose={(input) =>
                      runConversationAction(
                        "close",
                        () =>
                          closeConversation.mutateAsync({
                            campaignId,
                            conversationId: conversation.id,
                            data: input,
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

          {conversation ? (
            <div
              className={
                threadOpenOnNarrow
                  ? "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:col-span-2 xl:grid-cols-3"
                  : "hidden min-w-0 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:col-span-2 lg:grid xl:grid-cols-3"
              }
            >
              <ProgressPanel
                conversation={conversation}
                eventId={campaign?.eventId ?? ""}
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
                onCorrectAnswer={handleCorrectAnswer}
                onWithdrawAnswer={handleWithdrawAnswer}
                onAddAnswer={handleAddAnswer}
                answerUpdatePending={
                  correctAnswer.isPending || withdrawAnswer.isPending
                }
                addAnswerPending={addAnswer.isPending}
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
    </div>
  );
}
