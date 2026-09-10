import { Button, ListBox, Select } from "@heroui/react";

import { JtsDataTable } from "../../components/ui/JtsDataTable";
import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import { QUESTION_KEYS, questionLabel } from "../../features/feedback/labels";
import { usePageMeta } from "../../lib/usePageMeta";

import { ANY, useFeedbackResultsControls } from "./useFeedbackResultsControls";

export function FeedbackResultsPage() {
  const {
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
  } = useFeedbackResultsControls();

  usePageMeta(
    "Feedback results",
    "Every answer and note collected by one post-event feedback campaign.",
  );

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
        <span className="jts-overline text-ink-muted">Question</span>
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
        <span className="jts-overline text-ink-muted">Participant</span>
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
        <span className="jts-overline text-ink-muted">Review status</span>
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
        back={{
          to: `/admin/feedback/${campaignId}`,
          label: "Back to conversations",
        }}

        title="Results"
        description="What the table actually said, once the talking stopped: the answers people gave, and the things they mentioned that nobody asked about."
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
