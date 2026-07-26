import { Button, ListBox, Select } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";

import {
  useListFeedbackCampaignConversations,
  useListFeedbackCampaignResults,
} from "../api/generated/feedback-conversations";
import type { FeedbackConversationResultsDtoOutputAnswersItem } from "../api/generated/model/feedbackConversationResultsDtoOutputAnswersItem";
import type { FeedbackConversationResultsDtoOutputNotesItem } from "../api/generated/model/feedbackConversationResultsDtoOutputNotesItem";
import type { ListFeedbackCampaignResultsParams } from "../api/generated/model/listFeedbackCampaignResultsParams";
import type { ListFeedbackCampaignResultsQuestionKey } from "../api/generated/model/listFeedbackCampaignResultsQuestionKey";
import type { ListFeedbackCampaignResultsReviewStatus } from "../api/generated/model/listFeedbackCampaignResultsReviewStatus";
import { FeedbackBadges } from "../components/admin/feedback/FeedbackBadges";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { formatTimestamp } from "../features/feedback/conversationView";
import {
  QUESTION_KEYS,
  isUnresolvedParticipant,
  noteOriginLabel,
  noteTypeLabel,
  participantLabel,
  questionLabel,
  reviewStatusBadge,
  staffOriginBadge,
} from "../features/feedback/labels";
import { RESULTS_POLL_INTERVAL_MS } from "../features/feedback/polling";
import { usePageMeta } from "../lib/usePageMeta";

const ANY = "__any__";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : fallback;
}

/** Renders a participant name, marking the D18 fallback so it reads as absence. */
function ParticipantName({ displayName }: { displayName: string | null }) {
  return (
    <span
      className={
        isUnresolvedParticipant(displayName)
          ? "italic text-ink-muted"
          : undefined
      }
    >
      {participantLabel(displayName)}
    </span>
  );
}

/**
 * U4 — the campaign's results tab: every answer and every side note the
 * conversations produced, filterable by question, participant and review
 * status.
 *
 * Deliberately a list and not a dashboard. v1's done-criterion is that the
 * feedback exists and can be read end to end; charts and matrices wait until
 * someone has a question the list cannot answer.
 */
export function FeedbackResultsPage() {
  const { campaignId = "" } = useParams();

  const [questionKey, setQuestionKey] = useState<string>(ANY);
  const [participantId, setParticipantId] = useState<string>(ANY);
  const [reviewStatus, setReviewStatus] = useState<string>(ANY);

  usePageMeta(
    "Feedback results",
    "Every answer and note collected by one post-event feedback campaign.",
  );

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
    return [...rows]
      .map((row) => ({
        id: row.respondentParticipantId,
        label: participantLabel(row.respondentDisplayName),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "el"));
  }, [conversationsQuery.data?.conversations]);

  const answerColumns = useMemo<
    ColumnDef<FeedbackConversationResultsDtoOutputAnswersItem>[]
  >(
    () => [
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
    ],
    [],
  );

  const noteColumns = useMemo<
    ColumnDef<FeedbackConversationResultsDtoOutputNotesItem>[]
  >(
    () => [
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
    ],
    [],
  );

  const loadError = resultsQuery.isError
    ? errorMessage(resultsQuery.error, "Failed to load results.")
    : null;

  const answers = resultsQuery.data?.answers ?? [];
  const notes = resultsQuery.data?.notes ?? [];
  const filtered =
    questionKey !== ANY || participantId !== ANY || reviewStatus !== ANY;

  if (campaignId === "") {
    return (
      <p role="alert" className="text-sm text-danger">
        No campaign was given.
      </p>
    );
  }

  const filters = (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <span className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
          Question
        </span>
        <Select
          aria-label="Filter by question"
          selectedKey={questionKey}
          onSelectionChange={(key) => setQuestionKey(String(key ?? ANY))}
        >
          <Select.Trigger className="min-w-[10rem]">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={ANY} textValue="All questions">
                All questions
              </ListBox.Item>
              {QUESTION_KEYS.map((key) => (
                <ListBox.Item key={key} id={key} textValue={questionLabel(key)}>
                  {questionLabel(key)}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <span className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
          Participant
        </span>
        <Select
          aria-label="Filter by participant"
          selectedKey={participantId}
          onSelectionChange={(key) => setParticipantId(String(key ?? ANY))}
        >
          <Select.Trigger className="min-w-[12rem]">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={ANY} textValue="All participants">
                All participants
              </ListBox.Item>
              {respondents.map((respondent) => (
                <ListBox.Item
                  key={respondent.id}
                  id={respondent.id}
                  textValue={respondent.label}
                >
                  {respondent.label}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <span className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
          Review status
        </span>
        <Select
          aria-label="Filter notes by review status"
          selectedKey={reviewStatus}
          onSelectionChange={(key) => setReviewStatus(String(key ?? ANY))}
        >
          <Select.Trigger className="min-w-[9rem]">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={ANY} textValue="Any">
                Any
              </ListBox.Item>
              <ListBox.Item id="new" textValue="Needs review">
                Needs review
              </ListBox.Item>
              <ListBox.Item id="dismissed" textValue="Dismissed">
                Dismissed
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {filtered ? (
        <Button
          variant="ghost"
          onPress={() => {
            setQuestionKey(ANY);
            setParticipantId(ANY);
            setReviewStatus(ANY);
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Post-event feedback"
        title="Results"
        description="Everything the campaign's conversations produced: structured answers and the side notes flagged for review."
        actions={
          <Link
            to={`/admin/feedback/${campaignId}`}
            className="self-center text-sm font-semibold text-primary"
          >
            Back to conversations
          </Link>
        }
      />

      {filters}

      <JtsDataTable
        title="Answers"
        description="One row per recorded answer. Person questions name the subject; the score question carries a value."
        rows={answers}
        columns={answerColumns}
        getRowId={(row) => row.id}
        loading={resultsQuery.isPending}
        error={loadError}
        paginator
        pageSize={25}
        emptyTitle="No answers"
        emptyDescription={
          filtered
            ? "No answers match these filters."
            : "Answers appear as conversations progress."
        }
      />

      <JtsDataTable
        title="Notes"
        description="Side notes from the conversations, plus anything staff wrote by hand — the Source column says which. A note without a subject kept the name in its text for review (D18)."
        rows={notes}
        columns={noteColumns}
        getRowId={(row) => row.id}
        loading={resultsQuery.isPending}
        error={loadError}
        paginator
        pageSize={25}
        emptyTitle="No notes"
        emptyDescription={
          filtered
            ? "No notes match these filters."
            : "Notes appear when a participant mentions something outside the questions."
        }
      />
    </div>
  );
}
