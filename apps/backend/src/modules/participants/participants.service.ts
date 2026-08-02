import { Injectable } from "@nestjs/common";
import type { ParticipantRow } from "@join-the-six/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { toEventVenueView } from "../events/event-venue.js";
import type { ParticipantEventHistoryRow } from "./participants.repository.js";
import { ParticipantsRepository } from "./participants.repository.js";
import type {
  ParticipantEventHistoryItemView,
  ParticipantEventHistoryView,
  ParticipantListView,
  ParticipantView,
  UpdateParticipantFeedbackOptInInput,
} from "./participants.schemas.js";

export class ParticipantProfileNotFoundError extends Error {
  constructor(id: string) {
    super(`Participant ${id} was not found`);
    this.name = ParticipantProfileNotFoundError.name;
  }
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ParticipantsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(): Promise<ParticipantListView> {
    const rows = await this.repository.list();
    return { items: rows.map(toView) };
  }

  async get(id: string): Promise<ParticipantView> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new ParticipantProfileNotFoundError(id);
    }
    return toView(row);
  }

  async listEvents(id: string): Promise<ParticipantEventHistoryView> {
    const participant = await this.repository.findById(id);
    if (!participant) {
      throw new ParticipantProfileNotFoundError(id);
    }

    const rows = await this.repository.listEventsForParticipant(id);
    return { items: rows.map(toEventHistoryItemView) };
  }

  async updateFeedbackOptIn(
    id: string,
    input: UpdateParticipantFeedbackOptInInput,
    actorId: string,
    requestId: string,
  ): Promise<ParticipantView> {
    const updated = await this.database.transaction(async (transaction) => {
      const existing = await this.repository.findByIdForUpdate(transaction, id);
      if (!existing) {
        throw new ParticipantProfileNotFoundError(id);
      }

      const from = existing.postEventFeedbackWhatsappOptIn;
      const to = input.postEventFeedbackWhatsappOptIn;
      if (from === to) {
        return existing;
      }

      const row = await this.repository.updateFeedbackOptIn(
        transaction,
        id,
        to,
      );
      if (!row) {
        throw new ParticipantProfileNotFoundError(id);
      }

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "participant.feedback_whatsapp_opt_in_changed",
        entityType: "participant",
        entityId: row.id,
        requestId,
        context: { from, to },
      });
      return row;
    });

    return toView(updated);
  }
}

function toView(row: ParticipantRow): ParticipantView {
  return {
    id: row.id,
    preferredName: row.preferredName,
    emailNormalized: row.emailNormalized,
    phoneE164: row.phoneE164,
    ageBand: row.ageBand,
    preferredNeighborhood: row.preferredNeighborhood,
    conversationStyle: row.conversationStyle,
    postEventFeedbackWhatsappOptIn: row.postEventFeedbackWhatsappOptIn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEventHistoryItemView(
  row: ParticipantEventHistoryRow,
): ParticipantEventHistoryItemView {
  return {
    eventId: row.eventId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    status: row.status,
    venue: toEventVenueView(row),
    present: row.present,
    tableNo: row.tableNo,
  };
}
