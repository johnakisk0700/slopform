import type { ColumnDef } from "@tanstack/react-table";

import {
  FeedbackBadges,
  type FeedbackBadgeWithIcon,
} from "../../components/admin/feedback/FeedbackBadges";

interface DinnerRow {
  id: string;
  event: string;
  host: string;
  seats: string;
  badge: FeedbackBadgeWithIcon;
}

export const DINNER_ROWS: readonly DinnerRow[] = [
  {
    id: "row-kolonaki",
    event: "Δείπνο στο Κολωνάκι",
    host: "Ελένη Παπαδοπούλου",
    seats: "6 / 6",
    badge: { key: "ready", label: "Ready", tone: "success" },
  },
  {
    id: "row-pagkrati",
    event: "Πέμπτη στο Παγκράτι",
    host: "Νίκος Αντωνίου",
    seats: "4 / 6",
    badge: { key: "open", label: "Open", tone: "info" },
  },
  {
    id: "row-thessaloniki",
    event: "Δείπνο στη Θεσσαλονίκη",
    host: "Θανάσης Κυριακίδης",
    seats: "5 / 6",
    badge: { key: "waiting", label: "Needs venue", tone: "warning" },
  },
  {
    id: "row-kyriaki",
    event: "Κυριακάτικο τραπέζι",
    host: "Μαρία Βλάχου",
    seats: "0 / 6",
    badge: { key: "draft", label: "Draft", tone: "neutral" },
  },
];

export const DINNER_COLUMNS: ColumnDef<DinnerRow>[] = [
  {
    accessorKey: "event",
    header: "Event",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <strong className="font-bold text-ink">{row.original.event}</strong>
        <small className="text-xs text-ink-muted">{row.original.host}</small>
      </div>
    ),
  },
  {
    accessorKey: "seats",
    header: "Seats",
    meta: { align: "end" },
  },
  {
    accessorKey: "badge",
    header: "Stage",
    enableSorting: false,
    cell: ({ row }) => <FeedbackBadges badges={[row.original.badge]} />,
  },
];

export const QUEUE_SAMPLE: readonly {
  id: string;
  who: string;
  event: string;
  waiting: string;
}[] = [
  {
    id: "queue-1",
    who: "Ελένη Παπαδοπούλου",
    event: "Δείπνο στο Κολωνάκι",
    waiting: "2m 14s",
  },
  {
    id: "queue-2",
    who: "Νίκος Αντωνίου",
    event: "Πέμπτη στο Παγκράτι",
    waiting: "47s",
  },
  {
    id: "queue-3",
    who: "άγνωστος συμμετέχων",
    event: "Κυριακάτικο τραπέζι",
    waiting: "11m 03s",
  },
];

export const PARTICIPANT_SAMPLE: readonly string[] = [
  "Ελένη Παπαδοπούλου",
  "Νίκος Αντωνίου",
  "Μαρία Βλάχου",
  "Θανάσης Κυριακίδης",
  "Δήμητρα Σωτηρίου",
  "Αλέξανδρος Ρέππας",
  "Ιωάννα Μανωλάκη",
];
