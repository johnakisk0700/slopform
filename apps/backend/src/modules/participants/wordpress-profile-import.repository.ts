import {
  auditEvents,
  participantInterests,
  participants,
  participantSourceRecords,
  type AppTransaction,
  type ParticipantRow,
  type ParticipantSourceRecordRow,
} from "@slopform/database";
import { and, eq } from "drizzle-orm";

import type { CanonicalWordpressProfile } from "./wordpress-profile-import.schemas.js";

export class WordpressProfileImportRepository {
  async findSource(
    transaction: AppTransaction,
    sourceSystem: string,
    sourceRecordId: string,
  ): Promise<ParticipantSourceRecordRow | undefined> {
    const [record] = await transaction
      .select()
      .from(participantSourceRecords)
      .where(
        and(
          eq(participantSourceRecords.sourceSystem, sourceSystem),
          eq(participantSourceRecords.sourceRecordId, sourceRecordId),
        ),
      )
      .limit(1);

    return record;
  }

  async findParticipantById(
    transaction: AppTransaction,
    id: string,
  ): Promise<ParticipantRow | undefined> {
    const [record] = await transaction
      .select()
      .from(participants)
      .where(eq(participants.id, id))
      .limit(1);

    return record;
  }

  async findParticipantByEmail(
    transaction: AppTransaction,
    emailNormalized: string,
  ): Promise<ParticipantRow | undefined> {
    const [record] = await transaction
      .select()
      .from(participants)
      .where(eq(participants.emailNormalized, emailNormalized))
      .limit(1);

    return record;
  }

  async listInterests(transaction: AppTransaction, participantId: string) {
    return transaction
      .select()
      .from(participantInterests)
      .where(eq(participantInterests.participantId, participantId));
  }

  async createParticipant(
    transaction: AppTransaction,
    input: CanonicalWordpressProfile,
  ): Promise<ParticipantRow> {
    const [participant] = await transaction
      .insert(participants)
      .values({
        preferredName: input.profile.preferredName,
        emailNormalized: input.profile.emailNormalized,
        phoneE164: input.profile.phoneE164,
        ageBand: input.profile.ageBand,
        preferredNeighborhood: input.profile.preferredNeighborhood,
        conversationStyle: input.profile.conversationStyle,
      })
      .returning();

    if (!participant) {
      throw new Error("Participant insert returned no row");
    }

    await this.insertInterests(
      transaction,
      participant.id,
      input.profile.interests,
    );
    return participant;
  }

  async updateParticipant(
    transaction: AppTransaction,
    participantId: string,
    input: CanonicalWordpressProfile,
  ): Promise<void> {
    await transaction
      .update(participants)
      .set({
        preferredName: input.profile.preferredName,
        emailNormalized: input.profile.emailNormalized,
        phoneE164: input.profile.phoneE164,
        ageBand: input.profile.ageBand,
        preferredNeighborhood: input.profile.preferredNeighborhood,
        conversationStyle: input.profile.conversationStyle,
        updatedAt: new Date(),
      })
      .where(eq(participants.id, participantId));
    await transaction
      .delete(participantInterests)
      .where(eq(participantInterests.participantId, participantId));
    await this.insertInterests(
      transaction,
      participantId,
      input.profile.interests,
    );
  }

  async createSource(
    transaction: AppTransaction,
    participantId: string,
    sourceSystem: string,
    input: CanonicalWordpressProfile,
  ): Promise<void> {
    await transaction.insert(participantSourceRecords).values({
      participantId,
      sourceSystem,
      sourceRecordId: input.sourceProfileId,
      ...(input.sourceUserId ? { sourceUserId: input.sourceUserId } : {}),
      ...(input.sourceUpdatedAt
        ? { sourceUpdatedAt: input.sourceUpdatedAt }
        : {}),
      payloadHash: input.payloadHash,
    });
  }

  async updateSource(
    transaction: AppTransaction,
    sourceId: string,
    input: CanonicalWordpressProfile,
  ): Promise<void> {
    await transaction
      .update(participantSourceRecords)
      .set({
        sourceUserId: input.sourceUserId ?? null,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        payloadHash: input.payloadHash,
        importedAt: new Date(),
      })
      .where(eq(participantSourceRecords.id, sourceId));
  }

  async appendAudit(
    transaction: AppTransaction,
    participantId: string,
    action: string,
    sourceRecordId: string,
  ): Promise<void> {
    await transaction.insert(auditEvents).values({
      actorType: "migration",
      actorId: "wordpress-profile-import-v1",
      action,
      entityType: "participant",
      entityId: participantId,
      context: {
        sourceSystem: "wordpress",
        sourceRecordId,
      },
    });
  }

  private async insertInterests(
    transaction: AppTransaction,
    participantId: string,
    interests: readonly string[],
  ): Promise<void> {
    if (interests.length === 0) {
      return;
    }

    await transaction.insert(participantInterests).values(
      interests.map((interest) => ({
        participantId,
        interest,
      })),
    );
  }
}
