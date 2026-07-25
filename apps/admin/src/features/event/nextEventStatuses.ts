import type { EventDtoOutputStatus } from "../../api/generated/model/eventDtoOutputStatus";

export function nextEventStatuses(
  status: EventDtoOutputStatus,
): readonly EventDtoOutputStatus[] {
  if (status === "draft") {
    return ["scheduled", "cancelled"];
  }
  if (status === "scheduled") {
    return ["finished", "cancelled"];
  }
  return [];
}
