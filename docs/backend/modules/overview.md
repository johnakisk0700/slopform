# Overview read model

Status: implemented. Last verified: **2026-08-05**.

`GET /api/v1/overview` (`operationId: getOverview`) is the admin Operations
landing snapshot. It is a cross-domain read model: events and participants from
PostgreSQL, post-event feedback conversation tallies from MongoDB, outbound
undelivered counts from `message_outbox`, and campaign summary statuses from
PostgreSQL. Controllers stay thin; the service fans out in parallel; the Mongo
client never leaves `FeedbackConversationRepository`.

## Contract

- Authenticated admin only (`Cache-Control: no-store`).
- `observedAt` is the server clock every age reading is measured against.
- Fixed status keys always appear with zeros; attention reasons are a bounded
  non-zero array sorted by count.
- Honest labels only: attendee assignments and recorded presence — never
  bookings or capacity fiction.
- Assistant usage is out of scope: threads are owner-scoped personal workspaces.

Source: [`apps/backend/src/modules/overview/`](../../../apps/backend/src/modules/overview/).

## Aggregates and indexes

| Slice                                                     | Store                | Supporting indexes                                                                         |
| --------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| Event status / next scheduled / finished without campaign | PostgreSQL           | `events_status_starts_at_idx`, campaign event uniqueness                                   |
| Attendee / present totals                                 | PostgreSQL           | `event_attendees_event_present_idx`                                                        |
| Participant + feedback-contactable counts                 | PostgreSQL           | `participants_feedback_contactable_idx` (partial opt-in + phone)                           |
| Campaign and summary status counts                        | PostgreSQL           | `feedback_campaigns_status_launched_at_idx`, summary uniqueness                            |
| Conversation lifecycle / attention / parked               | MongoDB one `$facet` | `feedback_conversation_lifecycle_state_idx`, `feedback_conversation_attention_updated_idx` |
| Undelivered outbox + failed last 24h                      | PostgreSQL           | `message_outbox_status_created_idx`                                                        |

BullMQ is not consulted. PostgreSQL outbox statuses remain the delivery
authority, matching the outbound queue screen.
