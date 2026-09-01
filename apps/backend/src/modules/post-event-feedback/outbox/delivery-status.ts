import type { MessageOutboxDeliveryStatus } from "@slopform/database";

const MESSAGE_OUTBOX_DELIVERY_STATUS_RANK: Record<
  MessageOutboxDeliveryStatus,
  number
> = {
  error: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  played: 5,
};

/**
 * Delivery status never moves backwards. A later `messages.update` or
 * observation that reports an earlier state is ignored.
 */
export function coalesceDeliveryStatus(
  current: string | null | undefined,
  next: MessageOutboxDeliveryStatus,
): MessageOutboxDeliveryStatus {
  const known = current as MessageOutboxDeliveryStatus | null | undefined;
  if (
    known &&
    MESSAGE_OUTBOX_DELIVERY_STATUS_RANK[known] !== undefined &&
    MESSAGE_OUTBOX_DELIVERY_STATUS_RANK[known] >
      MESSAGE_OUTBOX_DELIVERY_STATUS_RANK[next]
  ) {
    return known;
  }
  return next;
}

export function deliveryTimestampFields(
  status: MessageOutboxDeliveryStatus,
  at: Date,
  current: {
    readonly sentAt?: Date | null;
    readonly deliveredAt?: Date | null;
    readonly readAt?: Date | null;
    readonly playedAt?: Date | null;
  } = {},
): {
  readonly sentAt?: Date;
  readonly deliveredAt?: Date;
  readonly readAt?: Date;
  readonly playedAt?: Date;
} {
  switch (status) {
    case "played":
      return {
        sentAt: current.sentAt ?? at,
        deliveredAt: current.deliveredAt ?? at,
        readAt: current.readAt ?? at,
        playedAt: current.playedAt ?? at,
      };
    case "read":
      return {
        sentAt: current.sentAt ?? at,
        deliveredAt: current.deliveredAt ?? at,
        readAt: current.readAt ?? at,
      };
    case "delivered":
      return {
        sentAt: current.sentAt ?? at,
        deliveredAt: current.deliveredAt ?? at,
      };
    case "sent":
      return { sentAt: current.sentAt ?? at };
    default:
      return {};
  }
}
