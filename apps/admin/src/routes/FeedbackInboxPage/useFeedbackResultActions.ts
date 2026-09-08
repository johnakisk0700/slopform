import { toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";

import {
  getListFeedbackCampaignResultsQueryKey,
  getListFeedbackConversationResultsQueryKey,
  useAddFeedbackConversationAnswer,
  useAddFeedbackConversationNote,
  useCorrectFeedbackConversationAnswer,
  useWithdrawFeedbackConversationAnswer,
} from "../../api/generated/feedback-conversations";
import { useUpdateFeedbackNoteReviewStatus } from "../../api/generated/feedback-notes";
import type { AddFeedbackConversationNoteDtoNoteType } from "../../api/generated/model/addFeedbackConversationNoteDtoNoteType";
import type { DirectedQuestionKey } from "../../features/feedback/directedAnswers";
import { apiErrorMessage } from "../../lib/api";

export function useFeedbackResultActions({
  campaignId,
  selectedId,
  setActionError,
}: {
  campaignId: string;
  selectedId: string | null;
  setActionError: (error: string | null) => void;
}) {
  const queryClient = useQueryClient();

  const updateNoteReviewStatus = useUpdateFeedbackNoteReviewStatus();

  const addNote = useAddFeedbackConversationNote();

  const correctAnswer = useCorrectFeedbackConversationAnswer();

  const withdrawAnswer = useWithdrawFeedbackConversationAnswer();

  const addAnswer = useAddFeedbackConversationAnswer();

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
  return {
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
  };
}
