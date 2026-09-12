import type { DatabaseService } from "../../infrastructure/database/database.service.js";

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

export class WordpressProfileImportService {
  constructor(
    private readonly database: Pick<DatabaseService, "transaction">,
    private readonly repository: Pick<
      WordpressProfileImportRepository,
      keyof WordpressProfileImportRepository
    > = new WordpressProfileImportRepository(),
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
