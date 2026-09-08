import { Button } from "@heroui/react";
import { Maximize2 } from "lucide-react";

import {
  CampaignContext,
  CampaignHeader,
} from "../../components/admin/feedback/CampaignHeader";
import { CampaignSummary } from "../../components/admin/feedback/CampaignSummary";
import { ConversationAttention } from "../../components/admin/feedback/ConversationAttention";
import {
  ConversationActions,
  NotesPanel,
  ProgressPanel,
  RespondentPanel,
} from "../../components/admin/feedback/ConversationDetails";
import { ConversationList } from "../../components/admin/feedback/ConversationList";
import {
  ConversationTranscript,
  ConversationTranscriptEmpty,
} from "../../components/admin/feedback/ConversationTranscript";
import { JtsBackLink } from "../../components/ui/JtsBackLink";
import { apiErrorMessage } from "../../lib/api";
import { usePageMeta } from "../../lib/usePageMeta";

import { useFeedbackInboxControls } from "./useFeedbackInboxControls";

export function FeedbackInboxPage() {
  const {
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
  } = useFeedbackInboxControls();

  usePageMeta(
    "Feedback conversations",
    "Read and steer post-event feedback conversations for one campaign.",
  );

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

        {/* Zero-minimum tracks keep loaded conversation panes from widening narrow screens. */}
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
