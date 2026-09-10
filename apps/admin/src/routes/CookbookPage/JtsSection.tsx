import { Button, ToggleButton } from "@heroui/react";
import { Calendar, CircleCheck, Clock, Users } from "lucide-react";
import { useState } from "react";

import { AssistantMarkdown } from "../../components/admin/assistant/AssistantMarkdown";
import { JtsBackLink } from "../../components/ui/JtsBackLink";
import { JtsDataTable } from "../../components/ui/JtsDataTable";
import { JtsLiveIndicator } from "../../components/ui/JtsLiveIndicator";
import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import { JtsStat } from "../../components/ui/JtsStat";

import { JTS_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";
import { DINNER_COLUMNS, DINNER_ROWS } from "./tableSpecimens";

export function JtsSection() {
  const [isSpinning, setSpinning] = useState(false);
  return (
    <Section spec={JTS_SECTION}>
      <div className="grid gap-2 rounded-md border border-border border-dashed bg-surface p-4">
        <p className="jts-overline text-ink-muted">
          JtsPageHeader — specimen frame
        </p>
        <p className="text-xs text-ink-subtle">
          The real one is at the top of this page. The copy below is a specimen:
          it is hidden from assistive technology, because JtsPageHeader renders
          an h1 and a page has exactly one. It holds no focusable control, so
          hiding it costs nobody anything.
        </p>
        {/* aria-hidden rather than a fake heading level: the point of the
              specimen is that it is the real component, unaltered. */}
        <div
          aria-hidden="true"
          className="rounded-sm bg-surface-sunken p-4 lg:px-8"
        >
          <JtsPageHeader
            title="Δείπνο στο Κολωνάκι"
            description="A quiet hashtag sits beside the title. A back link would sit above it. Actions are omitted from this hidden specimen."
          />
        </div>
      </div>

      <Specimen
        label="JtsBackLink"
        note="The one way out of a detail screen: left chevron, wine, «Back to <place>». JtsPageHeader takes it as `back` and puts it above the title. Kept outside the hidden frame above, because it is focusable."
      >
        {/* Points at the section it lives in, so the gallery's one live
              navigation control cannot navigate out of the gallery. */}
        <JtsBackLink to="/admin/cookbook#jts">Back to campaigns</JtsBackLink>
      </Specimen>

      <dl aria-label="JtsStat tones" className="grid gap-3 sm:grid-cols-3">
        <JtsStat
          label="Conversations"
          value={128}
          detail="Across every launched campaign"
          icon={Users}
        />
        <JtsStat
          label="Answered"
          value={94}
          detail="Every question closed"
          tone="success"
          icon={CircleCheck}
        />
        <JtsStat
          label="Waiting too long"
          value={7}
          detail="Older than ten minutes"
          tone="warning"
          icon={Clock}
        />
      </dl>

      <JtsDataTable
        rows={DINNER_ROWS}
        columns={DINNER_COLUMNS}
        getRowId={(row) => row.id}
        title="JtsDataTable"
        description="Sortable headers, a toolbar slot, zebra rows and the client paginator. Sample rows only — nothing here was fetched."
        paginator
        pageSize={3}
        rowsPerPageOptions={[3, 10, 25]}
        toolbarEnd={
          <Button variant="outline" size="sm">
            <Calendar aria-hidden="true" className="size-4" />
            Toolbar slot
          </Button>
        }
      />

      <Specimen
        label="JtsLiveIndicator"
        note="It occupies its space whether or not it is turning, so a poll never nudges the header beside it. Hold «Simulate a fetch» briefly — snappy toggles stay dark; a linger spins, then fades. It never changes colour — «working» is not a status anyone must act on."
      >
        <ToggleButton
          className="rounded-md"
          isSelected={isSpinning}
          onChange={setSpinning}
        >
          {isSpinning ? "Stop the fetch" : "Simulate a fetch"}
        </ToggleButton>
        <JtsLiveIndicator
          active={isSpinning}
          label="This specimen refreshes itself every few seconds."
        />
      </Specimen>

      <section
        id="assistant-cards"
        aria-label="Assistant card examples"
        className="scroll-mt-24"
      >
        <Specimen
          label="Assistant cards"
          note="Real assistant rendering: a tinted identity icon and name anchor the header; compact status badges sit above a separator. Each card fits its own content. Missing fields leave no row or empty body behind; malformed cards fall back to text."
          className="grid gap-3 sm:grid-cols-2"
        >
          <AssistantMarkdown>
            {
              '```jts\n{"kind":"profile","name":"Μαρία Κ.","email":"maria@example.com","phone":"+306900000000","neighborhood":"Κουκάκι","ageBand":"30-39","feedbackOptIn":true,"eventCount":4}\n```'
            }
          </AssistantMarkdown>
          <AssistantMarkdown>
            {
              '```jts\n{"kind":"event","title":"Δείπνο στο Παγκράτι","startsAt":"2026-08-09T18:00:00.000Z","status":"scheduled","venue":"Καφενείο","area":"Παγκράτι","attendeeCount":6,"presentCount":0}\n```'
            }
          </AssistantMarkdown>
          <AssistantMarkdown>
            {
              '```jts\n{"kind":"conversation","respondent":"Ειρήνη Κ.","campaign":"Δείπνο στο Παγκράτι","state":"open","control":"human","needsAttention":true,"answered":2,"goalCount":4,"messageCount":11,"lastMessageAt":"2026-08-01T20:14:00.000Z"}\n```'
            }
          </AssistantMarkdown>
          <AssistantMarkdown>
            {
              '```jts\n{"kind":"conversation","respondent":"Νίκος Α.","campaign":"Δείπνο στο Παγκράτι","state":"open","control":"bot","needsAttention":false,"answered":3,"goalCount":4,"messageCount":8,"lastMessageAt":"2026-08-01T20:16:00.000Z"}\n```'
            }
          </AssistantMarkdown>
          <AssistantMarkdown>
            {
              '```jts\n{"kind":"profile","name":"Άννα Μ.","phone":"+306911111111"}\n```'
            }
          </AssistantMarkdown>
          <AssistantMarkdown>
            {'```jts\n{"kind":"event","title":"Κυριακάτικο τραπέζι"}\n```'}
          </AssistantMarkdown>
        </Specimen>
      </section>
    </Section>
  );
}
