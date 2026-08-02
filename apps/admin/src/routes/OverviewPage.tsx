import { type FormEvent, type ReactNode, useRef, useState } from "react";
import {
  Button,
  Calendar,
  Chip,
  DateField,
  DatePicker,
  Input,
  Modal,
  ProgressBar,
  toast,
} from "@heroui/react";
import type { DateValue } from "@internationalized/date";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Calendar as CalendarIcon,
  CircleCheck,
  CreditCard,
  Filter,
  Info,
  type LucideIcon,
  MapPin,
  Network,
  Plus,
  Ticket,
  TriangleAlert,
} from "lucide-react";
import clsx from "clsx";

import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsStat } from "../components/ui/JtsStat";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  eventPreviewSchema,
  getEventPreviewErrors,
  type EventPreviewDraft,
} from "../features/event/schema";
import { usePageMeta } from "../lib/usePageMeta";

/** A single preview event row. All of it is local, reset-on-reload UI state. */
interface EventPreview {
  id: string;
  name: string;
  city: string;
  /** ISO `YYYY-MM-DD`, rendered in UTC so the calendar day never drifts. */
  date: string;
  bookings: number;
  capacity: number;
  blockers: number;
  status: "Draft" | "Open" | "Ready";
}

/** Ledger-stamp tones — the status hues sanctioned by the design contract. */
type StampTone = "primary" | "success" | "warning" | "danger" | "info";

const stampToneText: Record<StampTone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

const INITIAL_ROWS: readonly EventPreview[] = [
  {
    id: "preview-1",
    name: "Foundation dinner",
    city: "Athens",
    date: "2026-08-06",
    bookings: 18,
    capacity: 24,
    blockers: 2,
    status: "Open",
  },
  {
    id: "preview-2",
    name: "September dinner",
    city: "Athens",
    date: "2026-09-10",
    bookings: 0,
    capacity: 30,
    blockers: 1,
    status: "Draft",
  },
  {
    id: "preview-3",
    name: "Community table",
    city: "Athens",
    date: "2026-07-30",
    bookings: 22,
    capacity: 24,
    blockers: 0,
    status: "Ready",
  },
];

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function occupancy(event: EventPreview): number {
  return Math.round((event.bookings / event.capacity) * 100);
}

function statusTone(status: EventPreview["status"]): StampTone {
  if (status === "Ready") return "success";
  if (status === "Open") return "info";
  return "warning";
}

/**
 * A ledger "rubber stamp": a HeroUI Chip flattened to a transparent, outlined,
 * uppercase tag whose single hue is carried by `currentColor`.
 */
function Stamp({ tone, children }: { tone: StampTone; children: ReactNode }) {
  return (
    <Chip
      variant="tertiary"
      className={clsx(
        "rounded-sm border border-current/40 bg-transparent px-2 py-0.5 text-[0.7rem] font-extrabold uppercase tracking-[0.05em]",
        stampToneText[tone],
      )}
    >
      {children}
    </Chip>
  );
}

/** The event table columns. Module-level so TanStack gets a stable reference. */
const columns: ColumnDef<EventPreview>[] = [
  {
    accessorKey: "name",
    header: "Event",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <strong className="font-bold text-ink">{row.original.name}</strong>
        <small className="text-xs text-ink-muted">{row.original.city}</small>
      </div>
    ),
  },
  {
    accessorKey: "date",
    header: "Date",
    cell: ({ row }) => (
      <time dateTime={row.original.date}>{formatDate(row.original.date)}</time>
    ),
  },
  {
    accessorKey: "bookings",
    header: "Bookings",
    cell: ({ row }) => `${row.original.bookings} / ${row.original.capacity}`,
  },
  {
    accessorKey: "blockers",
    header: "Blockers",
    cell: ({ row }) =>
      row.original.blockers ? (
        <Stamp tone="warning">{row.original.blockers}</Stamp>
      ) : (
        <Stamp tone="success">Clear</Stamp>
      ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Stamp tone={statusTone(row.original.status)}>
        {row.original.status}
      </Stamp>
    ),
  },
];

/** One row in the "Needs attention" operator queue. */
interface QueueItem {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  stampTone: StampTone;
  stampLabel: ReactNode;
}

const attentionQueue: readonly QueueItem[] = [
  {
    icon: MapPin,
    title: "Confirm venue",
    subtitle: "Foundation dinner",
    stampTone: "danger",
    stampLabel: "Today",
  },
  {
    icon: CreditCard,
    title: "Review two payments",
    subtitle: "Missing references",
    stampTone: "warning",
    stampLabel: 2,
  },
  {
    icon: Network,
    title: "Lock table plan",
    subtitle: "Community table",
    stampTone: "success",
    stampLabel: "Ready",
  },
];

/** A single receipt-ruled row in the operator attention queue. */
function QueueRow({
  icon: Icon,
  title,
  subtitle,
  stampTone,
  stampLabel,
}: QueueItem) {
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <strong className="font-bold text-ink">{title}</strong>
        <small className="text-xs text-ink-muted">{subtitle}</small>
      </span>
      <span className="ml-auto">
        <Stamp tone={stampTone}>{stampLabel}</Stamp>
      </span>
    </li>
  );
}

/** A copper informational aside (contract motif #6). */
function CopperNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-md border border-copper/35 bg-copper-soft px-4 py-3 text-sm text-ink-muted"
    >
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-copper" />
      <span>{children}</span>
    </div>
  );
}

/** A focus card: kicker rendered above the title, optional wine left marker. */
function FocusCard({
  kicker,
  title,
  primary = false,
  children,
}: {
  kicker: string;
  title: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={clsx(
        "rounded-md border border-border bg-surface p-6",
        primary && "border-l-[3px] border-l-primary",
      )}
    >
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
        {kicker}
      </p>
      <h2 className="mb-4 text-[1.05rem] font-bold tracking-tight text-ink">
        {title}
      </h2>
      {children}
    </article>
  );
}

/**
 * The Operations control landing view: the operator's single-screen summary of
 * events, bookings and blockers. Every figure here is local preview state that
 * resets on reload — clearly labelled as such — until the operations API lands.
 */
export function OverviewPage() {
  usePageMeta(
    "Operations control",
    "Private Join The Six event operations workspace.",
  );

  const [previewRows, setPreviewRows] = useState<EventPreview[]>(() => [
    ...INITIAL_ROWS,
  ]);
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDate, setDraftDate] = useState<DateValue | null>(null);
  const dateFieldRef = useRef<HTMLDivElement>(null);
  const [formErrors, setFormErrors] = useState<
    Partial<Record<"name" | "date", string>>
  >({});

  const activePreviewEvents = previewRows.filter(
    (event) => event.status !== "Draft",
  ).length;
  const totalPreviewBookings = previewRows.reduce(
    (total, event) => total + event.bookings,
    0,
  );
  const openBlockers = previewRows.reduce(
    (total, event) => total + event.blockers,
    0,
  );
  const readyEvents = previewRows.filter(
    (event) => event.status === "Ready",
  ).length;
  const nextDinner = previewRows[0];

  function handleDialogOpenChange(open: boolean): void {
    if (open) {
      setDraftName("");
      setDraftDate(null);
      setFormErrors({});
    }
    setDialogOpen(open);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const draft: EventPreviewDraft = {
      // The picker yields a calendar day; read it as UTC so the stored date is
      // the day the operator chose, in any timezone.
      name: draftName,
      date: draftDate ? new Date(`${draftDate.toString()}T00:00:00Z`) : null,
    };
    const result = eventPreviewSchema.safeParse(draft);

    if (!result.success) {
      const errors = getEventPreviewErrors(draft);
      setFormErrors(errors);
      requestAnimationFrame(() => {
        if (errors.name) {
          document.getElementById("event-name")?.focus();
          return;
        }
        // The date field is a segmented input; focus its first segment.
        dateFieldRef.current
          ?.querySelector<HTMLElement>('[role="spinbutton"]')
          ?.focus();
      });
      return;
    }

    setFormErrors({});
    setPreviewRows((rows) => [
      ...rows,
      {
        id: crypto.randomUUID(),
        name: result.data.name,
        city: "Athens",
        date: result.data.date.toISOString().slice(0, 10),
        bookings: 0,
        capacity: 24,
        blockers: 1,
        status: "Draft",
      },
    ]);
    setDialogOpen(false);
    toast.success("Preview event created", {
      description: "Local UI state only; the events API is not connected yet.",
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Admin workspace"
        title="Operations control"
        description="Events, bookings and blockers in one focused workspace for the team running Join The Six."
        actions={
          <Modal isOpen={isDialogOpen} onOpenChange={handleDialogOpenChange}>
            <Button>
              <Plus aria-hidden="true" className="size-4" />
              New event
            </Button>
            <Modal.Backdrop>
              <Modal.Container size="md" placement="center">
                <Modal.Dialog>
                  <Modal.Header className="flex items-start justify-between gap-4">
                    <Modal.Heading className="text-[1.15rem] font-bold tracking-tight text-ink">
                      Create a preview event
                    </Modal.Heading>
                    <Modal.CloseTrigger />
                  </Modal.Header>
                  <Modal.Body>
                    <form
                      id="event-preview-form"
                      noValidate
                      onSubmit={handleSubmit}
                      className="grid gap-4"
                    >
                      <CopperNote>
                        This adds local UI state only and does not call an API.
                      </CopperNote>
                      <div className="grid gap-1.5">
                        <label
                          htmlFor="event-name"
                          className="flex items-center gap-2 text-sm font-semibold text-ink"
                        >
                          Event name
                          <span className="jts-overline text-ink-muted">
                            Required
                          </span>
                        </label>
                        <Input
                          id="event-name"
                          className="w-full"
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          autoComplete="off"
                          aria-invalid={formErrors.name ? true : undefined}
                          aria-describedby={
                            formErrors.name ? "event-name-error" : undefined
                          }
                        />
                        {formErrors.name ? (
                          <p
                            id="event-name-error"
                            className="text-sm text-danger"
                          >
                            {formErrors.name}
                          </p>
                        ) : null}
                      </div>
                      <div className="grid gap-1.5" ref={dateFieldRef}>
                        <DatePicker
                          aria-label="Dinner date"
                          value={draftDate}
                          onChange={setDraftDate}
                          isInvalid={Boolean(formErrors.date)}
                          {...(formErrors.date
                            ? { "aria-describedby": "event-date-error" }
                            : {})}
                          className="grid gap-1.5"
                        >
                          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                            Dinner date
                            <span className="jts-overline text-ink-muted">
                              Required
                            </span>
                          </span>
                          <DateField.Group>
                            <DateField.Input>
                              {(segment) => (
                                <DateField.Segment segment={segment} />
                              )}
                            </DateField.Input>
                            <DateField.Suffix>
                              <DatePicker.Trigger>
                                <DatePicker.TriggerIndicator />
                              </DatePicker.Trigger>
                            </DateField.Suffix>
                          </DateField.Group>
                          <DatePicker.Popover>
                            <Calendar aria-label="Choose the dinner date">
                              <Calendar.Header>
                                <Calendar.YearPickerTrigger>
                                  <Calendar.YearPickerTriggerHeading />
                                  <Calendar.YearPickerTriggerIndicator />
                                </Calendar.YearPickerTrigger>
                                <Calendar.NavButton slot="previous" />
                                <Calendar.NavButton slot="next" />
                              </Calendar.Header>
                              <Calendar.Grid>
                                <Calendar.GridHeader>
                                  {(day) => (
                                    <Calendar.HeaderCell>
                                      {day}
                                    </Calendar.HeaderCell>
                                  )}
                                </Calendar.GridHeader>
                                <Calendar.GridBody>
                                  {(date) => <Calendar.Cell date={date} />}
                                </Calendar.GridBody>
                              </Calendar.Grid>
                            </Calendar>
                          </DatePicker.Popover>
                        </DatePicker>
                        {formErrors.date ? (
                          <p
                            id="event-date-error"
                            className="text-sm text-danger"
                          >
                            {formErrors.date}
                          </p>
                        ) : null}
                      </div>
                    </form>
                  </Modal.Body>
                  <Modal.Footer className="flex justify-end gap-3">
                    <Button
                      variant="ghost"
                      onPress={() => setDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" form="event-preview-form">
                      Create event
                    </Button>
                  </Modal.Footer>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          </Modal>
        }
      />

      <CopperNote>
        Local product preview. The layout and interactions are real; the values
        reset on reload until the operations API is connected.
      </CopperNote>

      <dl
        aria-label="Operations summary"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <JtsStat
          label="Active events"
          value={activePreviewEvents}
          detail="Open or ready"
          icon={CalendarIcon}
        />
        <JtsStat
          label="Bookings"
          value={totalPreviewBookings}
          detail="Across preview events"
          icon={Ticket}
        />
        <JtsStat
          label="Open blockers"
          value={openBlockers}
          detail="Need operator action"
          tone="warning"
          icon={TriangleAlert}
        />
        <JtsStat
          label="Ready events"
          value={readyEvents}
          detail="Cleared to run"
          tone="success"
          icon={CircleCheck}
        />
      </dl>

      <section
        aria-label="Operational focus"
        className="grid gap-6 md:grid-cols-2"
      >
        <FocusCard kicker="Immediate event context" title="Next dinner" primary>
          {nextDinner ? (
            <div className="grid gap-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col">
                  <strong className="text-base font-bold text-ink">
                    {nextDinner.name}
                  </strong>
                  <span className="text-sm text-ink-muted">
                    {nextDinner.city} · {formatDate(nextDinner.date)}
                  </span>
                </div>
                <Stamp tone={statusTone(nextDinner.status)}>
                  {nextDinner.status}
                </Stamp>
              </div>
              <div className="grid gap-2">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-xs font-bold uppercase tracking-wide text-ink-muted">
                    Table capacity
                  </span>
                  <strong className="text-sm font-bold tabular-nums text-ink">
                    {nextDinner.bookings} / {nextDinner.capacity}
                  </strong>
                </div>
                <ProgressBar
                  aria-label={`Table occupancy for ${nextDinner.name}`}
                  value={occupancy(nextDinner)}
                >
                  <ProgressBar.Track className="h-1 rounded-none bg-surface-sunken">
                    <ProgressBar.Fill className="rounded-none" />
                  </ProgressBar.Track>
                </ProgressBar>
              </div>
            </div>
          ) : null}
        </FocusCard>

        <FocusCard kicker="Operator queue" title="Needs attention">
          <ul className="divide-y divide-dotted divide-border-strong">
            {attentionQueue.map((item) => (
              <QueueRow key={item.title} {...item} />
            ))}
          </ul>
        </FocusCard>
      </section>

      <JtsDataTable
        rows={previewRows}
        columns={columns}
        getRowId={(row) => row.id}
        title="Event operations"
        description="Current event stage, capacity and unresolved blockers."
        emptyTitle="No events yet"
        emptyDescription="Create the first event to start the operational workflow."
        paginator
        pageSize={5}
        rowsPerPageOptions={[5, 10, 25]}
        toolbarEnd={
          <Button variant="outline" isDisabled>
            <Filter aria-hidden="true" className="size-4" />
            Filters
          </Button>
        }
      />
    </div>
  );
}
