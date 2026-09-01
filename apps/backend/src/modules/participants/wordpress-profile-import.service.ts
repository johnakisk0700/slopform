import type {
  AppTransaction,
  ParticipantInterestRow,
  ParticipantRow,
  ParticipantSourceRecordRow,
} from "@slopform/database";

import { participantMatchesProfile } from "./wordpress-profile.mapper.js";
import { WordpressProfileImportRepository } from "./wordpress-profile-import.repository.js";
import {
  WORDPRESS_PROFILE_SOURCE,
  type CanonicalWordpressProfile,
} from "./wordpress-profile-import.schemas.js";

export type WordpressProfileImportOutcome =
  | { readonly status: "imported"; readonly participantId: string }
  | { readonly status: "updated"; readonly participantId: string }
  | { readonly status: "unchanged"; readonly participantId: string }
  | { readonly status: "linked_duplicate"; readonly participantId: string }
  | {
      readonly status: "conflict";
      readonly code: "duplicate_email_conflict" | "target_drift";
    };

interface ParticipantImportDatabase {
  transaction<T>(work: (transaction: AppTransaction) => Promise<T>): Promise<T>;
}

interface ParticipantImportRepository {
  findSource(
    transaction: AppTransaction,
    sourceSystem: string,
    sourceRecordId: string,
  ): Promise<ParticipantSourceRecordRow | undefined>;
  findParticipantById(
    transaction: AppTransaction,
    id: string,
  ): Promise<ParticipantRow | undefined>;
  findParticipantByEmail(
    transaction: AppTransaction,
    emailNormalized: string,
  ): Promise<ParticipantRow | undefined>;
  listInterests(
    transaction: AppTransaction,
    participantId: string,
  ): Promise<ParticipantInterestRow[]>;
  createParticipant(
    transaction: AppTransaction,
    input: CanonicalWordpressProfile,
  ): Promise<ParticipantRow>;
  updateParticipant(
    transaction: AppTransaction,
    participantId: string,
    input: CanonicalWordpressProfile,
  ): Promise<void>;
  createSource(
    transaction: AppTransaction,
    participantId: string,
    sourceSystem: string,
    input: CanonicalWordpressProfile,
  ): Promise<void>;
  updateSource(
    transaction: AppTransaction,
    sourceId: string,
    input: CanonicalWordpressProfile,
  ): Promise<void>;
  appendAudit(
    transaction: AppTransaction,
    participantId: string,
    action: string,
    sourceRecordId: string,
  ): Promise<void>;
}

export class WordpressProfileImportService {
  constructor(
    private readonly database: ParticipantImportDatabase,
    private readonly repository: ParticipantImportRepository = new WordpressProfileImportRepository(),
  ) {}

  async importOne(
    input: CanonicalWordpressProfile,
  ): Promise<WordpressProfileImportOutcome> {
    return this.database.transaction(async (transaction) => {
      const source = await this.repository.findSource(
        transaction,
        WORDPRESS_PROFILE_SOURCE,
        input.sourceProfileId,
      );

      if (source) {
        if (source.payloadHash === input.payloadHash) {
          const participant = await this.repository.findParticipantById(
            transaction,
            source.participantId,
          );

          if (!participant) {
            throw new Error(
              "Participant source points to a missing participant",
            );
          }

          const interests = await this.repository.listInterests(
            transaction,
            participant.id,
          );

          if (
            !participantMatchesProfile(participant, interests, input.profile)
          ) {
            return { status: "conflict", code: "target_drift" };
          }

          return { status: "unchanged", participantId: source.participantId };
        }

        const emailOwner = await this.repository.findParticipantByEmail(
          transaction,
          input.profile.emailNormalized,
        );

        if (emailOwner && emailOwner.id !== source.participantId) {
          return { status: "conflict", code: "duplicate_email_conflict" };
        }

        const participant = await this.repository.findParticipantById(
          transaction,
          source.participantId,
        );

        if (!participant) {
          throw new Error("Participant source points to a missing participant");
        }

        await this.repository.updateParticipant(
          transaction,
          participant.id,
          input,
        );
        await this.repository.updateSource(transaction, source.id, input);
        await this.repository.appendAudit(
          transaction,
          participant.id,
          "participant.wordpress_profile_updated",
          input.sourceProfileId,
        );

        return { status: "updated", participantId: participant.id };
      }

      const emailOwner = await this.repository.findParticipantByEmail(
        transaction,
        input.profile.emailNormalized,
      );

      if (emailOwner) {
        const interests = await this.repository.listInterests(
          transaction,
          emailOwner.id,
        );

        if (!participantMatchesProfile(emailOwner, interests, input.profile)) {
          return { status: "conflict", code: "duplicate_email_conflict" };
        }

        await this.repository.createSource(
          transaction,
          emailOwner.id,
          WORDPRESS_PROFILE_SOURCE,
          input,
        );
        await this.repository.appendAudit(
          transaction,
          emailOwner.id,
          "participant.wordpress_source_linked",
          input.sourceProfileId,
        );

        return { status: "linked_duplicate", participantId: emailOwner.id };
      }

      const participant = await this.repository.createParticipant(
        transaction,
        input,
      );
      await this.repository.createSource(
        transaction,
        participant.id,
        WORDPRESS_PROFILE_SOURCE,
        input,
      );
      await this.repository.appendAudit(
        transaction,
        participant.id,
        "participant.wordpress_profile_imported",
        input.sourceProfileId,
      );

      return { status: "imported", participantId: participant.id };
    });
  }
}
