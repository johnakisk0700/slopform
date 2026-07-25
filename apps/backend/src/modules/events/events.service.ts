import { Injectable } from "@nestjs/common";
import type { EventStatus } from "@join-the-six/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { selectFeedbackCandidates } from "./feedback-candidates.js";
import {
  EventsRepository,
  type EventAttendeeJoinedRow,
  type EventSummaryRow,
} from "./events.repository.js";
import {
  EVENT_STATUS_TRANSITIONS,
  type CreateEventInput,
  type EventAttendeeView,
  type EventDetailView,
  type EventListView,
  type EventView,
  type FeedbackCandidate,
  type FeedbackCandidatesView,
  type TransitionEventStatusInput,
  type UpdateEventAttendeeInput,
  type UpdateEventInput,
  type UpsertEventAttendeeInput,
} from "./events.schemas.js";

export class EventNotFoundError extends Error {
  constructor(id: string) {
    super(`Event ${id} was not found`);
    this.name = EventNotFoundError.name;
  }
}

export class EventAttendeeNotFoundError extends Error {
  constructor(eventId: string, attendeeId: string) {
    super(`Attendee ${attendeeId} was not found on event ${eventId}`);
    this.name = EventAttendeeNotFoundError.name;
  }
}

export class EventStatusTransitionError extends Error {
  constructor(from: EventStatus, to: EventStatus) {
    super(`Cannot transition event status from ${from} to ${to}`);
    this.name = EventStatusTransitionError.name;
  }
}

export class EventMutationNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = EventMutationNotAllowedError.name;
  }
}

export class ParticipantNotFoundError extends Error {
  constructor(id: string) {
    super(`Participant ${id} was not found`);
    this.name = ParticipantNotFoundError.name;
  }
}

export class EventAttendeeConflictError extends Error {
  constructor(eventId: string, participantId: string) {
    super(
      `Participant ${participantId} is already an attendee of event ${eventId}`,
    );
    this.name = EventAttendeeConflictError.name;
  }
}

@Injectable()
export class EventsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: EventsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async create(
    input: CreateEventInput,
    actorId: string,
    requestId: string,
  ): Promise<EventView> {
    const created = await this.database.transaction(async (transaction) => {
      const event = await this.repository.create(transaction, {
        title: input.title,
        startsAt: new Date(input.startsAt),
      });
      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "event.created",
        entityType: "event",
        entityId: event.id,
        requestId,
        context: { status: event.status },
      });
      return event;
    });

    return this.requireSummaryView(created.id);
  }

  async update(
    id: string,
    input: UpdateEventInput,
    actorId: string,
    requestId: string,
  ): Promise<EventView> {
    const updated = await this.database.transaction(async (transaction) => {
      const existing = await this.repository.findByIdForUpdate(transaction, id);
      if (!existing) {
        throw new EventNotFoundError(id);
      }
      if (existing.status === "finished" || existing.status === "cancelled") {
        throw new EventMutationNotAllowedError(
          `Cannot edit a ${existing.status} event`,
        );
      }

      const event = await this.repository.update(transaction, id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.startsAt !== undefined
          ? { startsAt: new Date(input.startsAt) }
          : {}),
      });
      if (!event) {
        throw new EventNotFoundError(id);
      }

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "event.updated",
        entityType: "event",
        entityId: event.id,
        requestId,
        context: {
          titleChanged: input.title !== undefined,
          startsAtChanged: input.startsAt !== undefined,
        },
      });
      return event;
    });

    return this.requireSummaryView(updated.id);
  }

  async transitionStatus(
    id: string,
    input: TransitionEventStatusInput,
    actorId: string,
    requestId: string,
  ): Promise<EventView> {
    const updated = await this.database.transaction(async (transaction) => {
      const existing = await this.repository.findByIdForUpdate(transaction, id);
      if (!existing) {
        throw new EventNotFoundError(id);
      }

      const from = existing.status as EventStatus;
      const to = input.status;
      const allowed = EVENT_STATUS_TRANSITIONS[from] as readonly EventStatus[];
      if (!allowed.includes(to)) {
        throw new EventStatusTransitionError(from, to);
      }

      const event = await this.repository.transitionStatus(transaction, id, to);
      if (!event) {
        throw new EventNotFoundError(id);
      }

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "event.status_transitioned",
        entityType: "event",
        entityId: event.id,
        requestId,
        context: { from, to },
      });
      return event;
    });

    return this.requireSummaryView(updated.id);
  }

  async list(): Promise<EventListView> {
    const rows = await this.repository.listSummaries();
    return { items: rows.map(toEventView) };
  }

  async get(id: string): Promise<EventDetailView> {
    const summary = await this.repository.summarize(id);
    if (!summary) {
      throw new EventNotFoundError(id);
    }
    const attendees = await this.repository.listAttendees(id);
    return {
      ...toEventView(summary),
      attendees: attendees.map(toAttendeeView),
    };
  }

  /**
   * Single source of the D16 candidate rule for extraction and validation.
   */
  async listFeedbackCandidatesForRespondent(
    eventId: string,
    respondentParticipantId: string,
  ): Promise<FeedbackCandidatesView> {
    const event = await this.repository.findById(eventId);
    if (!event) {
      throw new EventNotFoundError(eventId);
    }

    const present =
      await this.repository.listPresentAttendeeCandidates(eventId);
    const selected = selectFeedbackCandidates(present, respondentParticipantId);
    const items: FeedbackCandidate[] = selected.map((candidate) => ({
      participantId: candidate.participantId,
      displayName: candidate.displayName,
    }));

    return { items };
  }

  async upsertAttendee(
    eventId: string,
    input: UpsertEventAttendeeInput,
    actorId: string,
    requestId: string,
  ): Promise<EventAttendeeView> {
    const attendeeId = await this.database.transaction(async (transaction) => {
      const event = await this.repository.findByIdForUpdate(
        transaction,
        eventId,
      );
      if (!event) {
        throw new EventNotFoundError(eventId);
      }
      assertAttendanceEditable(event.status as EventStatus);

      const exists = await this.repository.participantExists(
        transaction,
        input.participantId,
      );
      if (!exists) {
        throw new ParticipantNotFoundError(input.participantId);
      }

      const existing = await this.repository.findAttendeeByParticipant(
        transaction,
        eventId,
        input.participantId,
      );
      if (existing) {
        throw new EventAttendeeConflictError(eventId, input.participantId);
      }

      const created = await this.repository.insertAttendee(transaction, {
        eventId,
        participantId: input.participantId,
        tableNo: input.tableNo ?? null,
        present: input.present ?? true,
      });

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "event_attendee.created",
        entityType: "event_attendee",
        entityId: created.id,
        requestId,
        context: {
          eventId,
          participantId: created.participantId,
          present: created.present,
          tableNo: created.tableNo,
        },
      });
      return created.id;
    });

    return this.requireAttendeeView(eventId, attendeeId);
  }

  async updateAttendee(
    eventId: string,
    attendeeId: string,
    input: UpdateEventAttendeeInput,
    actorId: string,
    requestId: string,
  ): Promise<EventAttendeeView> {
    await this.database.transaction(async (transaction) => {
      const event = await this.repository.findByIdForUpdate(
        transaction,
        eventId,
      );
      if (!event) {
        throw new EventNotFoundError(eventId);
      }
      // Finished events allow attendance corrections (present/table) via UPDATE only.
      if (event.status === "cancelled") {
        throw new EventMutationNotAllowedError(
          "Cannot edit attendance on a cancelled event",
        );
      }

      const updated = await this.repository.updateAttendee(
        transaction,
        eventId,
        attendeeId,
        {
          ...(input.tableNo !== undefined ? { tableNo: input.tableNo } : {}),
          ...(input.present !== undefined ? { present: input.present } : {}),
        },
      );
      if (!updated) {
        throw new EventAttendeeNotFoundError(eventId, attendeeId);
      }

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "event_attendee.updated",
        entityType: "event_attendee",
        entityId: updated.id,
        requestId,
        context: {
          eventId,
          participantId: updated.participantId,
          presentChanged: input.present !== undefined,
          tableNoChanged: input.tableNo !== undefined,
          present: updated.present,
          tableNo: updated.tableNo,
        },
      });
    });

    return this.requireAttendeeView(eventId, attendeeId);
  }

  private async requireSummaryView(id: string): Promise<EventView> {
    const summary = await this.repository.summarize(id);
    if (!summary) {
      throw new EventNotFoundError(id);
    }
    return toEventView(summary);
  }

  private async requireAttendeeView(
    eventId: string,
    attendeeId: string,
  ): Promise<EventAttendeeView> {
    const attendee = await this.repository.findAttendeeById(
      eventId,
      attendeeId,
    );
    if (!attendee) {
      throw new EventAttendeeNotFoundError(eventId, attendeeId);
    }
    return toAttendeeView(attendee);
  }
}

function assertAttendanceEditable(status: EventStatus): void {
  if (status === "cancelled") {
    throw new EventMutationNotAllowedError(
      "Cannot add attendees to a cancelled event",
    );
  }
}

function toEventView(row: EventSummaryRow): EventView {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    status: row.status as EventStatus,
    attendeeCount: row.attendeeCount,
    presentCount: row.presentCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAttendeeView(row: EventAttendeeJoinedRow): EventAttendeeView {
  return {
    id: row.id,
    eventId: row.eventId,
    participantId: row.participantId,
    preferredName: row.preferredName,
    emailNormalized: row.emailNormalized,
    tableNo: row.tableNo,
    present: row.present,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
