import { describe, expect, it, vi } from "vitest";

import type { FeedbackIngressRepository } from "./ingress.repository.js";
import type { PostEventFeedbackMaterializer } from "./materialize.service.js";
import {
  PostgresFeedbackMaterializationLimiter,
  PostgresSessionMaterializationLockHost,
  PostEventFeedbackMaterializationCoordinator,
  type FeedbackMaterializationLockHost,
  type FeedbackMaterializationLimiter,
} from "./materialization-coordinator.service.js";

const conversationPhone = "+306900000001";
const chatJid = "306900000001@s.whatsapp.net";
const earlierId = "11111111-1111-4111-8111-111111111111";
const laterId = "22222222-2222-4222-8222-222222222222";

describe("PostEventFeedbackMaterializationCoordinator", () => {
  it("drains one conversation in durable insert order even when provider time is backdated", async () => {
    const rows = [
      ingressRow(laterId, new Date("2026-08-03T09:00:00.000Z"), 2),
      ingressRow(earlierId, new Date("2026-08-03T10:00:00.000Z"), 1),
    ];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const repository = {
      findIngressById: vi.fn(async (id: string) => byId.get(id)),
      listPendingIngressForSerializationKey: vi.fn(async () =>
        [...rows].sort((left, right) => left.ingressOrder - right.ingressOrder),
      ),
    };
    const calls: string[] = [];
    const materializer = {
      materialize: vi.fn(async ({ ingressId }: { ingressId: string }) => {
        calls.push(ingressId);
        const row = byId.get(ingressId);
        if (row) row.processingStatus = "materialized";
        return {
          outcome: "inbound_materialized" as const,
          conversationId: "33333333-3333-4333-8333-333333333333",
        };
      }),
    };
    const limiter = {
      run: vi.fn(async (_key: unknown, work: () => Promise<unknown>) => work()),
    };
    const coordinator = new PostEventFeedbackMaterializationCoordinator(
      repository as unknown as FeedbackIngressRepository,
      materializer as unknown as PostEventFeedbackMaterializer,
      limiter as unknown as FeedbackMaterializationLimiter,
    );

    await coordinator.materialize({
      ingressId: laterId,
      correlationId: "corr-ordered",
    });

    expect(calls).toEqual([earlierId, laterId]);
    expect(limiter.run).toHaveBeenCalledWith(
      { phoneE164: conversationPhone, chatJid },
      expect.any(Function),
    );
    expect(
      repository.listPendingIngressForSerializationKey,
    ).toHaveBeenCalledWith({ phoneE164: conversationPhone, chatJid }, 2, 50);
  });

  it("resumes a durable burst after a worker dies without replaying settled rows", async () => {
    const rows = [
      ingressRow(earlierId, new Date("2026-08-03T10:00:00.000Z"), 1),
      ingressRow(laterId, new Date("2026-08-03T10:00:01.000Z"), 2),
    ];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const repository = {
      findIngressById: vi.fn(async (id: string) => byId.get(id)),
      listPendingIngressForSerializationKey: vi.fn(async () =>
        rows.filter((row) => row.processingStatus === "pending"),
      ),
    };
    const calls: string[] = [];
    let crash = true;
    const materializer = {
      materialize: vi.fn(async ({ ingressId }: { ingressId: string }) => {
        calls.push(ingressId);
        if (ingressId === laterId && crash) {
          crash = false;
          throw new Error("worker terminated");
        }
        const row = byId.get(ingressId);
        if (row) row.processingStatus = "materialized";
        return { outcome: "inbound_materialized" as const };
      }),
    };
    const limiter = {
      run: async (_key: unknown, work: () => Promise<unknown>) => work(),
    };
    const createCoordinator = () =>
      new PostEventFeedbackMaterializationCoordinator(
        repository as unknown as FeedbackIngressRepository,
        materializer as unknown as PostEventFeedbackMaterializer,
        limiter as unknown as FeedbackMaterializationLimiter,
      );

    await expect(
      createCoordinator().materialize({
        ingressId: laterId,
        correlationId: "corr-before-restart",
      }),
    ).rejects.toThrow("worker terminated");
    await createCoordinator().materialize({
      ingressId: laterId,
      correlationId: "corr-after-restart",
    });

    expect(calls).toEqual([earlierId, laterId, laterId]);
    expect(rows.map((row) => row.processingStatus)).toEqual([
      "materialized",
      "materialized",
    ]);
  });
});

describe("PostgresFeedbackMaterializationLimiter", () => {
  it("queues a hot local route before checking out another session lock", async () => {
    const host = {
      withSessionAdvisoryLock: vi.fn(
        async (_key: string, work: () => Promise<unknown>) => work(),
      ),
    };
    const limiter = new PostgresFeedbackMaterializationLimiter(
      host as unknown as FeedbackMaterializationLockHost,
    );
    let release!: () => void;
    const first = limiter.run(
      { phoneE164: conversationPhone, chatJid },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = limiter.run(
      { phoneE164: conversationPhone, chatJid },
      async () => undefined,
    );

    await vi.waitFor(() =>
      expect(host.withSessionAdvisoryLock).toHaveBeenCalledTimes(1),
    );
    release();
    await Promise.all([first, second]);
    expect(host.withSessionAdvisoryLock).toHaveBeenCalledTimes(2);
  });

  it("serializes one conversation across limiter instances", async () => {
    const database = new SharedSessionLockFake();
    const first = new PostgresFeedbackMaterializationLimiter(database);
    const second = new PostgresFeedbackMaterializationLimiter(database);
    const entered: string[] = [];
    let releaseFirst!: () => void;
    const firstRun = first.run(
      { phoneE164: conversationPhone, chatJid },
      async () => {
        entered.push("first");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    );
    const secondRun = second.run(
      { phoneE164: conversationPhone, chatJid },
      async () => {
        entered.push("second");
      },
    );

    await vi.waitFor(() => expect(entered).toEqual(["first"]));
    releaseFirst();
    await Promise.all([firstRun, secondRun]);

    expect(entered).toEqual(["first", "second"]);
  });

  it("does not serialize different conversations", async () => {
    const database = new SharedSessionLockFake();
    const limiter = new PostgresFeedbackMaterializationLimiter(database);
    const entered: string[] = [];
    let release!: () => void;

    const first = limiter.run(
      { phoneE164: conversationPhone, chatJid },
      async () => {
        entered.push("first");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    const second = limiter.run(
      {
        phoneE164: "+306900000002",
        chatJid: "306900000002@s.whatsapp.net",
      },
      async () => {
        entered.push("second");
      },
    );

    await vi.waitFor(() => expect(entered).toEqual(["first", "second"]));
    release();
    await Promise.all([first, second]);
  });
});

describe("PostgresSessionMaterializationLockHost", () => {
  it("holds and releases a dedicated session lock around the work", async () => {
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    const host = new PostgresSessionMaterializationLockHost({ pool } as never);
    const work = vi.fn().mockResolvedValue("done");

    await expect(
      host.withSessionAdvisoryLock("feedback:test", work),
    ).resolves.toBe("done");

    expect(query).toHaveBeenNthCalledWith(
      1,
      "select pg_advisory_lock(hashtextextended($1, 0))",
      ["feedback:test"],
    );
    expect(work).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(
      2,
      "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
      ["feedback:test"],
    );
    expect(release).toHaveBeenCalledWith();
  });

  it("destroys the dedicated session when unlock cannot be proved", async () => {
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    const host = new PostgresSessionMaterializationLockHost({ pool } as never);

    await expect(
      host.withSessionAdvisoryLock("feedback:test", async () => undefined),
    ).rejects.toThrow("ownership was lost");
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});

function ingressRow(id: string, observedAt: Date, ingressOrder: number) {
  return {
    id,
    ingressOrder,
    providerMessageId: `provider-${id}`,
    chatJid,
    direction: "inbound" as const,
    phoneE164: conversationPhone,
    text: "μήνυμα",
    observedAt,
    processingStatus: "pending" as "pending" | "materialized",
    matchedConversationId: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  };
}

class SharedSessionLockFake implements FeedbackMaterializationLockHost {
  private readonly locks = new Map<string, Promise<void>>();

  async withSessionAdvisoryLock<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }
}
