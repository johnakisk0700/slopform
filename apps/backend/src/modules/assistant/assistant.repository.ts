import { Injectable } from "@nestjs/common";
import {
  assistantThreads,
  assistantTurns,
  type AppDatabase,
  type AppTransaction,
  type AssistantThreadRow,
  type AssistantTurnRow,
} from "@join-the-six/database";
import { and, asc, desc, eq, inArray, lt, max, sql } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";
import type {
  AssistantFailureCode,
  AssistantModel,
  AssistantReasoningEffort,
} from "./assistant.schemas.js";

type DatabaseExecutor = AppDatabase | AppTransaction;

export interface AssistantThreadRecord {
  readonly thread: AssistantThreadRow;
  readonly turns: AssistantTurnRow[];
}

export interface PersistedAssistantTurn {
  readonly created: boolean;
  readonly thread: AssistantThreadRow;
  readonly turn: AssistantTurnRow;
}

export class AssistantActiveTurnPersistenceError extends Error {
  constructor() {
    super("The assistant thread already has an active turn");
    this.name = AssistantActiveTurnPersistenceError.name;
  }
}

export class AssistantRequestReplayPersistenceError extends Error {
  constructor() {
    super("The request id already belongs to a different assistant thread");
    this.name = AssistantRequestReplayPersistenceError.name;
  }
}

@Injectable()
export class AssistantRepository {
  constructor(private readonly database: DatabaseService) {}

  async createThreadWithTurn(input: {
    readonly createdBy: string;
    readonly requestId: string;
    readonly title: string;
    readonly model: AssistantModel;
    readonly effort: AssistantReasoningEffort;
    readonly content: string;
  }): Promise<PersistedAssistantTurn> {
    return this.database.transaction(async (transaction) => {
      await lockRequest(transaction, input.createdBy, input.requestId);
      const existing = await this.findByRequestIdForOwner(
        input.requestId,
        input.createdBy,
        transaction,
      );
      if (existing) {
        return { created: false, ...existing };
      }

      const [thread] = await transaction
        .insert(assistantThreads)
        .values({ createdBy: input.createdBy, title: input.title })
        .returning();
      if (!thread) {
        throw new Error("Assistant thread insert returned no row");
      }

      const [turn] = await transaction
        .insert(assistantTurns)
        .values({
          threadId: thread.id,
          createdBy: input.createdBy,
          requestId: input.requestId,
          sequence: 1,
          model: input.model,
          effort: input.effort,
          userContent: input.content,
        })
        .returning();
      if (!turn) {
        throw new Error("Assistant turn insert returned no row");
      }

      return { created: true, thread, turn };
    });
  }

  async appendTurn(input: {
    readonly threadId: string;
    readonly createdBy: string;
    readonly requestId: string;
    readonly model: AssistantModel;
    readonly effort: AssistantReasoningEffort;
    readonly content: string;
  }): Promise<PersistedAssistantTurn | undefined> {
    return this.database.transaction(async (transaction) => {
      await lockRequest(transaction, input.createdBy, input.requestId);
      const replay = await this.findByRequestIdForOwner(
        input.requestId,
        input.createdBy,
        transaction,
      );
      if (replay) {
        if (replay.thread.id !== input.threadId) {
          throw new AssistantRequestReplayPersistenceError();
        }
        return { created: false, ...replay };
      }

      await lockThread(transaction, input.threadId);
      const thread = await this.findThreadForOwner(
        input.threadId,
        input.createdBy,
        transaction,
      );
      if (!thread) {
        return undefined;
      }

      const [latest] = await transaction
        .select({
          sequence: max(assistantTurns.sequence),
          hasActive: sql<boolean>`bool_or(${assistantTurns.status} in ('queued', 'running'))`,
        })
        .from(assistantTurns)
        .where(eq(assistantTurns.threadId, thread.id));
      if (latest?.hasActive) {
        throw new AssistantActiveTurnPersistenceError();
      }
      const sequence = (latest?.sequence ?? 0) + 1;
      const now = new Date();
      const [turn] = await transaction
        .insert(assistantTurns)
        .values({
          threadId: thread.id,
          createdBy: input.createdBy,
          requestId: input.requestId,
          sequence,
          model: input.model,
          effort: input.effort,
          userContent: input.content,
        })
        .returning();
      if (!turn) {
        throw new Error("Assistant turn insert returned no row");
      }

      const [updatedThread] = await transaction
        .update(assistantThreads)
        .set({ updatedAt: now })
        .where(eq(assistantThreads.id, thread.id))
        .returning();
      if (!updatedThread) {
        throw new Error("Assistant thread update returned no row");
      }

      return { created: true, thread: updatedThread, turn };
    });
  }

  async findThreadRecordForOwner(
    id: string,
    createdBy: string,
  ): Promise<AssistantThreadRecord | undefined> {
    const thread = await this.findThreadForOwner(
      id,
      createdBy,
      this.database.db,
    );
    if (!thread) {
      return undefined;
    }

    const turns = await this.database.db
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.threadId, id))
      .orderBy(asc(assistantTurns.sequence));
    return { thread, turns };
  }

  async listThreadRecordsForOwner(
    createdBy: string,
  ): Promise<AssistantThreadRecord[]> {
    const threads = await this.database.db
      .select()
      .from(assistantThreads)
      .where(eq(assistantThreads.createdBy, createdBy))
      .orderBy(desc(assistantThreads.updatedAt))
      .limit(50);
    if (threads.length === 0) {
      return [];
    }

    const threadIds = threads.map((thread) => thread.id);
    const turns = await this.database.db
      .select()
      .from(assistantTurns)
      .where(inArray(assistantTurns.threadId, threadIds))
      .orderBy(asc(assistantTurns.sequence));

    return threads.map((thread) => ({
      thread,
      turns: turns.filter((turn) => turn.threadId === thread.id),
    }));
  }

  findRequestForOwner(
    requestId: string,
    createdBy: string,
  ): Promise<
    | { readonly thread: AssistantThreadRow; readonly turn: AssistantTurnRow }
    | undefined
  > {
    return this.findByRequestIdForOwner(requestId, createdBy, this.database.db);
  }

  async findStaleNonterminalTurns(
    staleBefore: Date,
    limit: number,
  ): Promise<AssistantTurnRow[]> {
    return this.database.db
      .select()
      .from(assistantTurns)
      .where(
        and(
          inArray(assistantTurns.status, ["queued", "running"]),
          lt(assistantTurns.updatedAt, staleBefore),
        ),
      )
      .orderBy(asc(assistantTurns.updatedAt))
      .limit(limit);
  }

  async findTurnById(id: string): Promise<AssistantTurnRow | undefined> {
    const [turn] = await this.database.db
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.id, id))
      .limit(1);
    return turn;
  }

  async findTurnForOwner(
    threadId: string,
    turnId: string,
    createdBy: string,
  ): Promise<AssistantTurnRow | undefined> {
    const [record] = await this.database.db
      .select({ turn: assistantTurns })
      .from(assistantTurns)
      .innerJoin(
        assistantThreads,
        eq(assistantThreads.id, assistantTurns.threadId),
      )
      .where(
        and(
          eq(assistantTurns.id, turnId),
          eq(assistantTurns.threadId, threadId),
          eq(assistantThreads.createdBy, createdBy),
        ),
      )
      .limit(1);
    return record?.turn;
  }

  async findContextTurns(turn: AssistantTurnRow): Promise<AssistantTurnRow[]> {
    const turns = await this.database.db
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.threadId, turn.threadId))
      .orderBy(asc(assistantTurns.sequence));

    return turns.filter((candidate) =>
      candidate.sequence < turn.sequence
        ? candidate.status === "succeeded"
        : candidate.id === turn.id,
    );
  }

  async markRunning(
    id: string,
    attempt: number,
  ): Promise<AssistantTurnRow | undefined> {
    const now = new Date();
    const [turn] = await this.database.db
      .update(assistantTurns)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(
        and(
          eq(assistantTurns.id, id),
          eq(assistantTurns.attempt, attempt),
          inArray(assistantTurns.status, ["queued", "running"]),
        ),
      )
      .returning();
    return turn;
  }

  async markQueued(id: string, attempt: number): Promise<void> {
    await this.database.db
      .update(assistantTurns)
      .set({ status: "queued", updatedAt: new Date() })
      .where(
        and(
          eq(assistantTurns.id, id),
          eq(assistantTurns.attempt, attempt),
          inArray(assistantTurns.status, ["queued", "running"]),
        ),
      );
  }

  async markSucceeded(
    id: string,
    attempt: number,
    response: string,
  ): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .update(assistantTurns)
        .set({
          status: "succeeded",
          assistantContent: response,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(assistantTurns.id, id),
            eq(assistantTurns.attempt, attempt),
            inArray(assistantTurns.status, ["queued", "running"]),
          ),
        )
        .returning();
      if (turn) {
        await transaction
          .update(assistantThreads)
          .set({ updatedAt: now })
          .where(eq(assistantThreads.id, turn.threadId));
      }
    });
  }

  async markFailed(
    id: string,
    attempt: number,
    code: AssistantFailureCode,
    message: string,
  ): Promise<boolean> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .update(assistantTurns)
        .set({
          status: "failed",
          assistantContent: null,
          errorCode: code,
          errorMessage: message,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(assistantTurns.id, id),
            eq(assistantTurns.attempt, attempt),
            inArray(assistantTurns.status, ["queued", "running"]),
          ),
        )
        .returning();
      if (turn) {
        await transaction
          .update(assistantThreads)
          .set({ updatedAt: now })
          .where(eq(assistantThreads.id, turn.threadId));
      }
      return !!turn;
    });
  }

  async retryFailedTurn(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly createdBy: string;
  }): Promise<AssistantTurnRow | undefined> {
    return this.database.transaction(async (transaction) => {
      await lockThread(transaction, input.threadId);
      const thread = await this.findThreadForOwner(
        input.threadId,
        input.createdBy,
        transaction,
      );
      if (!thread) {
        return undefined;
      }

      const [latest] = await transaction
        .select()
        .from(assistantTurns)
        .where(eq(assistantTurns.threadId, input.threadId))
        .orderBy(desc(assistantTurns.sequence))
        .limit(1);
      if (!latest || latest.id !== input.turnId || latest.status !== "failed") {
        return undefined;
      }

      const now = new Date();
      const [turn] = await transaction
        .update(assistantTurns)
        .set({
          status: "queued",
          attempt: sql`${assistantTurns.attempt} + 1`,
          assistantContent: null,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(assistantTurns.id, input.turnId),
            eq(assistantTurns.status, "failed"),
          ),
        )
        .returning();
      if (turn) {
        await transaction
          .update(assistantThreads)
          .set({ updatedAt: now })
          .where(eq(assistantThreads.id, input.threadId));
      }
      return turn;
    });
  }

  private async findByRequestIdForOwner(
    requestId: string,
    createdBy: string,
    executor: DatabaseExecutor,
  ): Promise<
    | { readonly thread: AssistantThreadRow; readonly turn: AssistantTurnRow }
    | undefined
  > {
    const [record] = await executor
      .select({ thread: assistantThreads, turn: assistantTurns })
      .from(assistantTurns)
      .innerJoin(
        assistantThreads,
        eq(assistantThreads.id, assistantTurns.threadId),
      )
      .where(
        and(
          eq(assistantTurns.requestId, requestId),
          eq(assistantThreads.createdBy, createdBy),
        ),
      )
      .limit(1);
    return record;
  }

  private async findThreadForOwner(
    id: string,
    createdBy: string,
    executor: DatabaseExecutor,
  ): Promise<AssistantThreadRow | undefined> {
    const [thread] = await executor
      .select()
      .from(assistantThreads)
      .where(
        and(
          eq(assistantThreads.id, id),
          eq(assistantThreads.createdBy, createdBy),
        ),
      )
      .limit(1);
    return thread;
  }
}

async function lockRequest(
  transaction: AppTransaction,
  createdBy: string,
  requestId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`assistant-request:${createdBy}:${requestId}`}, 0))`,
  );
}

async function lockThread(
  transaction: AppTransaction,
  threadId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`assistant-thread:${threadId}`}, 0))`,
  );
}
