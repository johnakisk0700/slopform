import { Chip } from "@heroui/react";

import {
  eventStatusColor,
  eventStatusLabel,
  type EventStatus,
} from "../../../features/event/eventStatus";

/**
 * An event's status as a chip. The label is always present, so the status never
 * rests on colour alone; the mapping itself lives in `features/event/` where it
 * stays React-free and testable.
 */
export function EventStatusChip({
  status,
  size = "sm",
}: {
  status: EventStatus;
  size?: "sm" | "md";
}) {
  return (
    <Chip color={eventStatusColor(status)} size={size} variant="soft">
      <Chip.Label>{eventStatusLabel(status)}</Chip.Label>
    </Chip>
  );
}
