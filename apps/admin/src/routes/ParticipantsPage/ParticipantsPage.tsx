import { SearchField } from "@heroui/react";
import { Search, Users, X } from "lucide-react";

import { JtsDataTable } from "../../components/ui/JtsDataTable";
import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import { usePageMeta } from "../../lib/usePageMeta";

import { useParticipantsControls } from "./useParticipantsControls";

export function ParticipantsPage() {
  const { participantsQuery, query, setQuery, rows, loading, error, columns } =
    useParticipantsControls();

  usePageMeta(
    "Participants",
    "Participant profiles and feedback WhatsApp opt-in.",
  );

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Operations"
        title="Participants"
        description="Whose phone we are allowed to reach after a dinner. Silence is the default, and every change here is signed and dated."
      />

      <JtsDataTable
        title="Participants"
        description={
          query.trim() === ""
            ? null
            : `${rows.length} of ${participantsQuery.data?.items.length ?? 0} match “${query.trim()}”.`
        }
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        error={error}
        paginator
        pageSize={25}
        rowsPerPageOptions={[25, 50, 100]}
        emptyTitle={
          query.trim() === "" ? "No participants" : "Nobody matches that"
        }
        emptyDescription={
          query.trim() === ""
            ? "Import WordPress profiles before managing opt-in."
            : "Try a different name, email or phone."
        }
        emptyIcon={
          <Users
            aria-hidden="true"
            className="size-9 text-ink-subtle"
            strokeWidth={1.5}
          />
        }
        toolbarEnd={
          <SearchField
            aria-label="Search participants"
            value={query}
            onChange={setQuery}
            className="max-sm:w-full"
          >
            <SearchField.Group>
              <SearchField.SearchIcon>
                <Search aria-hidden="true" className="size-4" />
              </SearchField.SearchIcon>
              <SearchField.Input placeholder="Name, email or phone…" />
              <SearchField.ClearButton>
                <X aria-hidden="true" className="size-4" />
              </SearchField.ClearButton>
            </SearchField.Group>
          </SearchField>
        }
      />
    </div>
  );
}
