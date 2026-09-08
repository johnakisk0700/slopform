import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useParams } from "react-router";

import {
  useListFeedbackCampaignConversations,
  useListFeedbackCampaignResults,
} from "../../api/generated/feedback-conversations";
import type { FeedbackConversationResultsDtoOutputAnswersItem } from "../../api/generated/model/feedbackConversationResultsDtoOutputAnswersItem";
import type { FeedbackConversationResultsDtoOutputNotesItem } from "../../api/generated/model/feedbackConversationResultsDtoOutputNotesItem";
import type { ListFeedbackCampaignResultsParams } from "../../api/generated/model/listFeedbackCampaignResultsParams";
import type { ListFeedbackCampaignResultsQuestionKey } from "../../api/generated/model/listFeedbackCampaignResultsQuestionKey";
import type { ListFeedbackCampaignResultsReviewStatus } from "../../api/generated/model/listFeedbackCampaignResultsReviewStatus";
import { FeedbackBadges } from "../../components/admin/feedback/FeedbackBadges";
import { ParticipantName } from "../../components/admin/feedback/ParticipantName";
import { formatTimestamp } from "../../features/feedback/conversationView";
import {
  noteOriginLabel,
  noteTypeLabel,
  participantLabel,
  questionLabel,
  reviewStatusBadge,
  staffOriginBadge,
} from "../../features/feedback/labels";
import { RESULTS_POLL_INTERVAL_MS } from "../../features/feedback/polling";
import { apiErrorMessage } from "../../lib/api";

export function useFeedbackResultsControls() {
  const { campaignId = "" } = useParams();

  const [questionKey, setQuestionKey] = useState(ANY);

  const [participantId, setParticipantId] = useState(ANY);

  const [reviewStatus, setReviewStatus] = useState(ANY);

  const params: ListFeedbackCampaignResultsParams = {
    ...(questionKey === ANY
      ? {}
      : {
          questionKey: questionKey as ListFeedbackCampaignResultsQuestionKey,
        }),
    ...(participantId === ANY ? {} : { participantId }),
    ...(reviewStatus === ANY
      ? {}
      : {
          reviewStatus: reviewStatus as ListFeedbackCampaignResultsReviewStatus,
        }),
  };

  const resultsQuery = useListFeedbackCampaignResults(campaignId, params, {
    query: {
      enabled: campaignId !== "",
      refetchInterval: RESULTS_POLL_INTERVAL_MS,
    },
  });

  // Respondents come from the campaign's own conversations, so the participant
  // filter can only offer ids that exist in this campaign.
  const conversationsQuery = useListFeedbackCampaignConversations(campaignId, {
    query: { enabled: campaignId !== "" },
  });

  const respondents = useMemo(() => {
    const rows = conversationsQuery.data?.conversations ?? [];
    return rows
      .map((row) => ({
        id: row.respondentParticipantId,
        label: participantLabel(row.respondentDisplayName),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "el"));
  }, [conversationsQuery.data?.conversations]);

  const loadError = resultsQuery.isError
    ? apiErrorMessage(resultsQuery.error, "Failed to load results.")
    : null;

  const answers = resultsQuery.data?.answers ?? [];

  const notes = resultsQuery.data?.notes ?? [];

  const filtered =
    questionKey !== ANY || participantId !== ANY || reviewStatus !== ANY;
  return {
    campaignId,
    questionKey,
    setQuestionKey,
    participantId,
    setParticipantId,
    reviewStatus,
    setReviewStatus,
    resultsQuery,
    respondents,
    answerColumns,
    noteColumns,
    loadError,
    answers,
    notes,
    filtered,
  };
}

export const ANY = "__any__";

const answerColumns: ColumnDef<FeedbackConversationResultsDtoOutputAnswersItem>[] =
  [
    {
      accessorKey: "respondentDisplayName",
      header: "Respondent",
      cell: ({ row }) => (
        <ParticipantName displayName={row.original.respondentDisplayName} />
      ),
    },
    {
      accessorKey: "questionKey",
      header: "Question",
      cell: ({ row }) => questionLabel(row.original.questionKey),
    },
    {
      id: "value",
      header: "Answer",
      cell: ({ row }) =>
        row.original.valueInt === null ? (
          <ParticipantName displayName={row.original.subjectDisplayName} />
        ) : (
          <span className="tabular-nums">{row.original.valueInt} / 5</span>
        ),
    },
    {
      accessorKey: "createdAt",
      header: "Recorded",
      meta: { align: "end" },
      cell: ({ row }) => formatTimestamp(row.original.createdAt),
    },
  ];

const noteColumns: ColumnDef<FeedbackConversationResultsDtoOutputNotesItem>[] =
  [
    {
      accessorKey: "respondentDisplayName",
      header: "Respondent",
      cell: ({ row }) => (
        <ParticipantName displayName={row.original.respondentDisplayName} />
      ),
    },
    {
      accessorKey: "noteType",
      header: "Type",
      cell: ({ row }) => noteTypeLabel(row.original.noteType),
    },
    {
      accessorKey: "text",
      header: "Note",
      cell: ({ row }) => (
        <span className="whitespace-pre-wrap">{row.original.text}</span>
      ),
    },
    {
      id: "subject",
      header: "About",
      cell: ({ row }) =>
        row.original.subjectParticipantId === null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <ParticipantName displayName={row.original.subjectDisplayName} />
        ),
    },
    {
      // A note an operator typed must never read as participant testimony,
      // so origin is its own labelled column rather than an inline hint.
      accessorKey: "origin",
      header: "Source",
      cell: ({ row }) => {
        const badge = staffOriginBadge(row.original.origin);
        return badge ? (
          <FeedbackBadges badges={[badge]} />
        ) : (
          <span className="text-ink-muted">
            {noteOriginLabel(row.original.origin)}
          </span>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Review",
      cell: ({ row }) => (
        <FeedbackBadges badges={[reviewStatusBadge(row.original.status)]} />
      ),
    },
  ];
