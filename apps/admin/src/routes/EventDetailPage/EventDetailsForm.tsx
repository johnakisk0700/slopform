import { Button, Input } from "@heroui/react";
import { PencilLine } from "lucide-react";
import { useState, type FormEvent } from "react";

import type { EventDetailDtoOutput } from "../../api/generated/model/eventDetailDtoOutput";

function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface EventDetailsFormProps {
  event: EventDetailDtoOutput;
  saving: boolean;
  onSave: (details: { title: string; startsAt: string }) => Promise<void>;
}

/**
 * Title and start time, shown only while the event can still take them. Once
 * it is finished or cancelled the backend refuses the edit, and a form whose
 * every control is dead is just a paragraph pretending to be one.
 */
export function EventDetailsForm({
  event,
  saving,
  onSave,
}: EventDetailsFormProps) {
  const [title, setTitle] = useState(event.title);
  const [startsAt, setStartsAt] = useState(
    toDateTimeLocalValue(event.startsAt),
  );

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    await onSave({ title, startsAt });
  }

  return (
    <section
      aria-labelledby="event-details-heading"
      className="rounded-md border border-border bg-surface px-4 py-4"
    >
      <h2
        id="event-details-heading"
        className="mb-4 flex items-center gap-2 jts-overline text-ink-muted"
      >
        <PencilLine aria-hidden="true" className="size-4 shrink-0" />
        Event details
      </h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-[16rem] flex-1 gap-1.5">
          <label htmlFor="event-title" className="text-sm font-semibold">
            Title
          </label>
          <Input
            id="event-title"
            value={title}
            onChange={(change) => setTitle(change.target.value)}
            disabled={saving}
            required
          />
        </div>
        <div className="grid min-w-[14rem] gap-1.5">
          <label htmlFor="event-starts-at" className="text-sm font-semibold">
            Starts at
          </label>
          <Input
            id="event-starts-at"
            type="datetime-local"
            value={startsAt}
            onChange={(change) => setStartsAt(change.target.value)}
            disabled={saving}
            required
          />
        </div>
        <Button type="submit" variant="secondary" isDisabled={saving}>
          Save details
        </Button>
      </form>
    </section>
  );
}
