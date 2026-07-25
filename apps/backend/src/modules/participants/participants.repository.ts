import { Injectable } from "@nestjs/common";
import {
  participants,
  type AppTransaction,
  type ParticipantRow,
} from "@join-the-six/database";
import { asc, eq, inArray } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

@Injectable()
export class ParticipantsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<ParticipantRow[]> {
    return this.database.db
      .select()
      .from(participants)
      .orderBy(
        asc(participants.preferredName),
        asc(participants.emailNormalized),
      )
      .limit(500);
  }

  async findById(id: string): Promise<ParticipantRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(participants)
      .where(eq(participants.id, id))
      .limit(1);

    return row;
  }

  async findByIds(ids: readonly string[]): Promise<ParticipantRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.database.db
      .select()
      .from(participants)
      .where(inArray(participants.id, [...ids]));
  }

  async findByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<ParticipantRow | undefined> {
    const [row] = await transaction
      .select()
      .from(participants)
      .where(eq(participants.id, id))
      .limit(1)
      .for("update");

    return row;
  }

  async updateFeedbackOptIn(
    transaction: AppTransaction,
    id: string,
    postEventFeedbackWhatsappOptIn: boolean,
  ): Promise<ParticipantRow | undefined> {
    const [row] = await transaction
      .update(participants)
      .set({
        postEventFeedbackWhatsappOptIn,
        updatedAt: new Date(),
      })
      .where(eq(participants.id, id))
      .returning();

    return row;
  }
}
