import type {
  AppTransaction,
  ReferenceRecordRow,
} from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { ReferenceRepository } from "./reference.repository.js";
import {
  ReferenceRecordNotFoundError,
  ReferenceService,
} from "./reference.service.js";

const record: ReferenceRecordRow = {
  id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  label: "Scaffold record",
  createdAt: new Date("2026-07-22T10:00:00.000Z"),
};

function createService(options?: { readonly found?: boolean }): {
  readonly auditAppend: ReturnType<typeof vi.fn>;
  readonly repositoryCreate: ReturnType<typeof vi.fn>;
  readonly service: ReferenceService;
  readonly transaction: AppTransaction;
} {
  const transaction = { transaction: "sentinel" } as unknown as AppTransaction;
  const repositoryCreate = vi.fn().mockResolvedValue(record);
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const database = {
    transaction: vi.fn(
      async <T>(work: (current: AppTransaction) => Promise<T>): Promise<T> =>
        work(transaction),
    ),
  } as unknown as DatabaseService;
  const repository = {
    create: repositoryCreate,
    findById: vi
      .fn()
      .mockResolvedValue(options?.found === false ? undefined : record),
  } as unknown as ReferenceRepository;
  const audit = { append: auditAppend } as unknown as AuditRepository;

  return {
    auditAppend,
    repositoryCreate,
    service: new ReferenceService(database, repository, audit),
    transaction,
  };
}

describe("ReferenceService", () => {
  it("creates the record and audit event in the same transaction", async () => {
    const { auditAppend, repositoryCreate, service, transaction } =
      createService();

    await expect(
      service.create(
        { label: "Scaffold record" },
        { actorType: "system", requestId: "request-1" },
      ),
    ).resolves.toEqual({
      id: record.id,
      label: record.label,
      createdAt: "2026-07-22T10:00:00.000Z",
    });

    expect(repositoryCreate).toHaveBeenCalledWith(
      transaction,
      "Scaffold record",
    );
    expect(auditAppend).toHaveBeenCalledWith(transaction, {
      actorType: "system",
      action: "reference_record.created",
      entityType: "reference_record",
      entityId: record.id,
      requestId: "request-1",
      context: {},
    });
  });

  it("reports a transport-neutral not-found error", async () => {
    const { service } = createService({ found: false });

    await expect(service.get(record.id)).rejects.toBeInstanceOf(
      ReferenceRecordNotFoundError,
    );
  });
});
