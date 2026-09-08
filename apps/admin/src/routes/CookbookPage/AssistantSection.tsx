import { AssistantReasoningCard } from "../../components/admin/assistant/AssistantReasoningCard";
import { AssistantToolCallCard } from "../../components/admin/assistant/AssistantToolCallCard";
import type { AssistantToolCall } from "../../features/assistant/schema";

import { ASSISTANT_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";

export function AssistantSection() {
  return (
    <Section spec={ASSISTANT_SECTION}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen
          label="Tool call — done, open it"
          note="Live component, fixture data. The payloads are the part to judge: keys in primary, strings in ink, numbers in accent, punctuation receding — on the same surface fenced code gets in an answer."
          className="grid gap-2"
        >
          <AssistantToolCallCard call={TOOL_CALL_DONE} />
        </Specimen>

        <Specimen
          label="Tool call — running & failed"
          note="Running breathes on the label and spins at the end of the row; failed keeps the input and says plainly that provider internals stay hidden."
          className="grid gap-2"
        >
          <AssistantToolCallCard call={TOOL_CALL_RUNNING} />
          <AssistantToolCallCard call={TOOL_CALL_FAILED} />
        </Specimen>

        <Specimen
          label="Thinking — settled"
          note="Reasoning is never styled as prose: italic, muted, and collapsed by default, so nobody mistakes the workings for the answer."
          className="grid gap-2"
        >
          <AssistantReasoningCard
            reasoning={REASONING_SAMPLE}
            streaming={false}
          />
        </Specimen>

        <Specimen
          label="Thinking — streaming"
          note="The same disclosure while the turn is still in flight."
          className="grid gap-2"
        >
          <AssistantReasoningCard
            reasoning={REASONING_SAMPLE}
            streaming={true}
          />
        </Specimen>
      </div>
    </Section>
  );
}

/**
 * The cookbook: every visual building block the panel owns, on one screen.
 *
 * It exists so that a change to `tokens.css` or to the HeroUI bridge in
 * `globals.css` can be judged in one place instead of by touring the real
 * screens and hoping the tour covered the affected component. Everything here
 * is a live component — a swatch is painted by the utility it names, and the
 * HeroUI specimens are the same components the product uses — so a repaint is
 * visible rather than described.
 *
 * It is development-only. `App.tsx` and `AdminNavigation.tsx` gate the route and
 * the nav row on `import.meta.env.DEV`, which Vite folds to `false` in a
 * production build, so this module is never reached and never bundled.
 *
 * Nothing here fetches: the page must render with the backend down, because the
 * moment somebody wants to check a token is not the moment to require a
 * database. Sample content is invented and in the product's own voice.
 */

const TOOL_CALL_DONE: AssistantToolCall = {
  toolCallId: "cookbook-tool-done",
  tool: "find_participants",
  label: "Searching participants",
  state: "done",
  input: { query: "Γκροκούλα", status: "confirmed", limit: 5 },
  output: {
    participants: [
      { name: "Λούλα Γκροκούλα", phone: "+30690000602", dinners: 3 },
      { name: "Θανάσης Γκροκομήτρος", phone: "+30690000603", dinners: 1 },
    ],
    total: 2,
    truncated: false,
  },
  inputTruncated: false,
  outputTruncated: true,
};

const TOOL_CALL_RUNNING: AssistantToolCall = {
  toolCallId: "cookbook-tool-running",
  tool: "list_events",
  label: "Listing events",
  state: "running",
  input: { from: "2026-08-01", statuses: ["published", "finished"] },
  output: null,
  inputTruncated: false,
  outputTruncated: false,
};

const TOOL_CALL_FAILED: AssistantToolCall = {
  toolCallId: "cookbook-tool-failed",
  tool: "find_participants",
  label: "Searching participants",
  state: "failed",
  input: { query: "Ρούλα", limit: 5 },
  output: null,
  inputTruncated: false,
  outputTruncated: false,
};

const REASONING_SAMPLE =
  "The operator is asking about attendance for the Ουζερί dinner. I should look up the campaign's conversations first, then cross-reference the participants who confirmed but never answered the feedback questions.";
