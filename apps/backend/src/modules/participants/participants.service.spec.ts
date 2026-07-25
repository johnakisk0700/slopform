import type { AppTransaction, ParticipantRow } from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { ParticipantsRepository } from "./participants.repository.js";
import {
  ParticipantProfileNotFoundError,
  ParticipantsService,
} from "./participants.service.js";

const participant: ParticipantRow = {
  id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  preferredName: "Roula",
  emailNormalized: "roula@example.com",
  phoneE164: "+306912345678",
  ageBand: "25_34",
  preferredNeighborhood: "pangrati",
  conversationStyle: 3,
  postEventFeedbackWhatsappOptIn: false,
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
};

describe("ParticipantsService feedback opt-in", () => {
  it("flips the opt-in flag and writes an audit event", async () => {
    const transaction = {} as AppTransaction;
    const updated = {
      ...participant,
      postEventFeedbackWhatsappOptIn: true,
      updatedAt: new Date("2026-07-25T01:00:00.000Z"),
    };
    const repository = {
      findByIdForUpdate: vi.fn().mockResolvedValue(participant),
      updateFeedbackOptIn: vi.fn().mockResolvedValue(updated),
      list: vi.fn(),
      findById: vi.fn(),
    } as unknown as ParticipantsRepository;
    const auditAppend = vi.fn().mockResolvedValue(undefined);
    const database = {
      transaction: vi.fn(
        async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
          work(transaction),
      ),
    } as unknown as DatabaseService;
    const service = new ParticipantsService(database, repository, {
      append: auditAppend,
    } as unknown as AuditRepository);

    await expect(
      service.updateFeedbackOptIn(
        participant.id,
        { postEventFeedbackWhatsappOptIn: true },
        "user_admin",
        "request-1",
      ),
    ).resolves.toMatchObject({ postEventFeedbackWhatsappOptIn: true });

    expect(repository.updateFeedbackOptIn).toHaveBeenCalledWith(
      transaction,
      participant.id,
      true,
    );
    expect(auditAppend).toHaveBeenCalledWith(transaction, {
      actorType: "admin",
      actorId: "user_admin",
      action: "participant.feedback_whatsapp_opt_in_changed",
      entityType: "participant",
      entityId: participant.id,
      requestId: "request-1",
      context: { from: false, to: true },
    });
  });

  it("is a no-op when the value is unchanged", async () => {
    const transaction = {} as AppTransaction;
    const repository = {
      findByIdForUpdate: vi.fn().mockResolvedValue(participant),
      updateFeedbackOptIn: vi.fn(),
    } as unknown as ParticipantsRepository;
    const auditAppend = vi.fn();
    const service = new ParticipantsService(
      {
        transaction: vi.fn(
          async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
            work(transaction),
        ),
      } as unknown as DatabaseService,
      repository,
      { append: auditAppend } as unknown as AuditRepository,
    );

    await service.updateFeedbackOptIn(
      participant.id,
      { postEventFeedbackWhatsappOptIn: false },
      "user_admin",
      "request-2",
    );

    expect(repository.updateFeedbackOptIn).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalled();
  });

  it("reports missing participants", async () => {
    const service = new ParticipantsService(
      {
        transaction: vi.fn(
          async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
            work({} as AppTransaction),
        ),
      } as unknown as DatabaseService,
      {
        findByIdForUpdate: vi.fn().mockResolvedValue(undefined),
      } as unknown as ParticipantsRepository,
      { append: vi.fn() } as unknown as AuditRepository,
    );

    await expect(
      service.updateFeedbackOptIn(
        participant.id,
        { postEventFeedbackWhatsappOptIn: true },
        "user_admin",
        "request-3",
      ),
    ).rejects.toBeInstanceOf(ParticipantProfileNotFoundError);
  });
});
