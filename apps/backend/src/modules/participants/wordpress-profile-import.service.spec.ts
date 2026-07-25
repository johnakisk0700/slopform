import type {
  AppTransaction,
  ParticipantInterestRow,
  ParticipantRow,
  ParticipantSourceRecordRow,
} from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import { WordpressProfileImportService } from "./wordpress-profile-import.service.js";
import type { CanonicalWordpressProfile } from "./wordpress-profile-import.schemas.js";

const transaction = {} as AppTransaction;

const input: CanonicalWordpressProfile = {
  sourceProfileId: "42",
  sourceUserId: "7",
  sourceUpdatedAt: new Date("2026-07-22T12:00:00Z"),
  payloadHash: "a".repeat(64),
  profile: {
    preferredName: "Γιάννης",
    emailNormalized: "test@example.gr",
    phoneE164: "+306969696969",
    ageBand: "25_34",
    preferredNeighborhood: "kolonaki",
    conversationStyle: 3,
    interests: ["travel", "technology"],
  },
};

function participant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "f34152c1-d8a6-4a68-af74-eb2c01a8f74e",
    preferredName: input.profile.preferredName,
    emailNormalized: input.profile.emailNormalized,
    phoneE164: input.profile.phoneE164,
    ageBand: input.profile.ageBand,
    preferredNeighborhood: input.profile.preferredNeighborhood,
    conversationStyle: input.profile.conversationStyle,
    createdAt: new Date("2026-07-22T12:00:00Z"),
    updatedAt: new Date("2026-07-22T12:00:00Z"),
    ...overrides,
  };
}

function source(
  overrides: Partial<ParticipantSourceRecordRow> = {},
): ParticipantSourceRecordRow {
  return {
    id: "26754940-9c65-40f5-ad12-f4fd3ac27c93",
    participantId: participant().id,
    sourceSystem: "wordpress-jts-profile",
    sourceRecordId: input.sourceProfileId,
    sourceUserId: input.sourceUserId ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    payloadHash: input.payloadHash,
    importedAt: new Date("2026-07-22T12:00:00Z"),
    ...overrides,
  };
}

function interests(): ParticipantInterestRow[] {
  return input.profile.interests.map((interest) => ({
    participantId: participant().id,
    interest,
    createdAt: new Date("2026-07-22T12:00:00Z"),
  }));
}

function setup() {
  const repository = {
    findSource: vi.fn(
      async () => undefined as ParticipantSourceRecordRow | undefined,
    ),
    findParticipantById: vi.fn(
      async () => undefined as ParticipantRow | undefined,
    ),
    findParticipantByEmail: vi.fn(
      async () => undefined as ParticipantRow | undefined,
    ),
    listInterests: vi.fn(async () => [] as ParticipantInterestRow[]),
    createParticipant: vi.fn(async () => participant()),
    updateParticipant: vi.fn(async () => undefined),
    createSource: vi.fn(async () => undefined),
    updateSource: vi.fn(async () => undefined),
    appendAudit: vi.fn(async () => undefined),
  };
  const database = {
    transaction: async <T>(
      work: (current: AppTransaction) => Promise<T>,
    ): Promise<T> => work(transaction),
  };
  const service = new WordpressProfileImportService(database, repository);

  return { repository, service };
}

describe("WordpressProfileImportService", () => {
  it("is idempotent when the source payload hash is unchanged", async () => {
    const { repository, service } = setup();
    repository.findSource.mockResolvedValue(source());
    repository.findParticipantById.mockResolvedValue(participant());
    repository.listInterests.mockResolvedValue(interests());

    await expect(service.importOne(input)).resolves.toEqual({
      status: "unchanged",
      participantId: participant().id,
    });
    expect(repository.updateParticipant).not.toHaveBeenCalled();
    expect(repository.appendAudit).not.toHaveBeenCalled();
  });

  it("reports target drift instead of claiming an unchanged replay", async () => {
    const { repository, service } = setup();
    repository.findSource.mockResolvedValue(source());
    repository.findParticipantById.mockResolvedValue(
      participant({ conversationStyle: 5 }),
    );
    repository.listInterests.mockResolvedValue(interests());

    await expect(service.importOne(input)).resolves.toEqual({
      status: "conflict",
      code: "target_drift",
    });
    expect(repository.updateParticipant).not.toHaveBeenCalled();
    expect(repository.appendAudit).not.toHaveBeenCalled();
  });

  it("updates the same participant when its source payload changes", async () => {
    const { repository, service } = setup();
    repository.findSource.mockResolvedValue(
      source({ payloadHash: "b".repeat(64) }),
    );
    repository.findParticipantById.mockResolvedValue(participant());

    await expect(service.importOne(input)).resolves.toEqual({
      status: "updated",
      participantId: participant().id,
    });
    expect(repository.updateParticipant).toHaveBeenCalledOnce();
    expect(repository.updateSource).toHaveBeenCalledOnce();
    expect(repository.appendAudit).toHaveBeenCalledWith(
      transaction,
      participant().id,
      "participant.wordpress_profile_updated",
      input.sourceProfileId,
    );
  });

  it("links an identical duplicate email to the existing participant", async () => {
    const { repository, service } = setup();
    repository.findParticipantByEmail.mockResolvedValue(participant());
    repository.listInterests.mockResolvedValue(interests());

    await expect(service.importOne(input)).resolves.toEqual({
      status: "linked_duplicate",
      participantId: participant().id,
    });
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(repository.createSource).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate email with conflicting profile data", async () => {
    const { repository, service } = setup();
    repository.findParticipantByEmail.mockResolvedValue(
      participant({ phoneE164: "+306900000000" }),
    );
    repository.listInterests.mockResolvedValue(interests());

    await expect(service.importOne(input)).resolves.toEqual({
      status: "conflict",
      code: "duplicate_email_conflict",
    });
    expect(repository.createSource).not.toHaveBeenCalled();
    expect(repository.appendAudit).not.toHaveBeenCalled();
  });

  it("creates the participant, source provenance and audit atomically", async () => {
    const { repository, service } = setup();

    await expect(service.importOne(input)).resolves.toEqual({
      status: "imported",
      participantId: participant().id,
    });
    expect(repository.createParticipant).toHaveBeenCalledOnce();
    expect(repository.createSource).toHaveBeenCalledOnce();
    expect(repository.appendAudit).toHaveBeenCalledWith(
      transaction,
      participant().id,
      "participant.wordpress_profile_imported",
      input.sourceProfileId,
    );
  });
});
