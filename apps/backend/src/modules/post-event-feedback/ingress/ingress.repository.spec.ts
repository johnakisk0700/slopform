import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";

const olderThan = new Date("2026-08-04T00:05:00.000Z");
const after = {
  createdAt: new Date("2026-08-04T00:00:00.000Z"),
  ingressId: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
};

describe("FeedbackIngressRepository pending recovery", () => {
  it("keyset-scans pending rows by created-at and id", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new FeedbackIngressRepository({
      db: { select },
    } as unknown as DatabaseService);

    await expect(
      repository.listPendingIngressOlderThan({
        olderThan,
        after,
        limit: 50,
      }),
    ).resolves.toEqual([]);

    const predicate = where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"processing_status" =');
    expect(query.sql).toContain('"created_at" <=');
    expect(query.sql).toContain('"created_at" >');
    expect(query.sql).toContain('"id" >');
    expect(query.params).toEqual([
      "pending",
      olderThan.toISOString(),
      after.createdAt.toISOString(),
      after.createdAt.toISOString(),
      after.ingressId,
    ]);
    expect(orderBy).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
    expect(limit).toHaveBeenCalledWith(50);
  });
});
