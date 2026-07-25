import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  AssistantThreadRow,
  AssistantTurnRow,
} from "@join-the-six/database";

import type { Environment } from "../../infrastructure/config/environment.js";
import { assistantModelAdapter } from "./assistant-models.js";
import {
  AssistantActiveTurnPersistenceError,
  AssistantRepository,
  AssistantRequestReplayPersistenceError,
  type AssistantThreadRecord,
} from "./assistant.repository.js";
import {
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_REASONING_EFFORT,
  type AssistantFailureCode,
  type AssistantModel,
  type AssistantReasoningEffort,
  type AssistantThreadListView,
  type AssistantThreadView,
  type AssistantTurnView,
  type CreateAssistantThreadInput,
  type CreateAssistantTurnInput,
} from "./assistant.schemas.js";

export class AssistantThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`Assistant thread ${id} was not found`);
    this.name = AssistantThreadNotFoundError.name;
  }
}

export class AssistantTurnNotFoundError extends Error {
  constructor(id: string) {
    super(`Assistant turn ${id} was not found`);
    this.name = AssistantTurnNotFoundError.name;
  }
}

export class AssistantTurnConflictError extends Error {
  constructor(message = "The assistant thread already has an active turn") {
    super(message);
    this.name = AssistantTurnConflictError.name;
  }
}

export class AssistantProviderUnavailableError extends Error {
  constructor() {
    super("The selected assistant model is not configured");
    this.name = AssistantProviderUnavailableError.name;
  }
}

export interface AssistantTurnCreation {
  readonly created: boolean;
  readonly turn: AssistantTurnView;
}

export interface AssistantThreadCreation {
  readonly created: boolean;
  readonly thread: AssistantThreadView;
  readonly turn: AssistantTurnView;
}

export interface AssistantTurnExecution {
  readonly turn: AssistantTurnRow;
  readonly messages: Array<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: AssistantRepository,
  ) {}

  async createThread(
    input: CreateAssistantThreadInput,
    createdBy: string,
  ): Promise<AssistantThreadCreation> {
    const model = input.model ?? DEFAULT_ASSISTANT_MODEL;
    const effort = input.effort ?? DEFAULT_ASSISTANT_REASONING_EFFORT;
    const replay = await this.repository.findRequestForOwner(
      input.requestId,
      createdBy,
    );
    if (replay) {
      if (replay.turn.sequence !== 1) {
        throw new AssistantTurnConflictError(
          "The request id already belongs to a different assistant operation",
        );
      }
      assertIdempotentReplay(replay.turn, input, model, effort);
      const record = await this.repository.findThreadRecordForOwner(
        replay.thread.id,
        createdBy,
      );
      if (!record) {
        throw new AssistantThreadNotFoundError(replay.thread.id);
      }
      return {
        created: false,
        thread: this.toThreadView(record),
        turn: this.toTurnView(replay.turn),
      };
    }

    this.assertProviderConfigured(model);
    const persisted = await this.repository.createThreadWithTurn({
      createdBy,
      requestId: input.requestId,
      title: titleFromContent(input.content),
      model,
      effort,
      content: input.content,
    });
    if (!persisted.created && persisted.turn.sequence !== 1) {
      throw new AssistantTurnConflictError(
        "The request id already belongs to a different assistant operation",
      );
    }
    assertIdempotentReplay(persisted.turn, input, model, effort);
    const record = await this.repository.findThreadRecordForOwner(
      persisted.thread.id,
      createdBy,
    );
    if (!record) {
      throw new AssistantThreadNotFoundError(persisted.thread.id);
    }

    return {
      created: persisted.created,
      thread: this.toThreadView(record),
      turn: this.toTurnView(persisted.turn),
    };
  }

  async appendTurn(
    threadId: string,
    input: CreateAssistantTurnInput,
    createdBy: string,
  ): Promise<AssistantTurnCreation> {
    const model = input.model ?? DEFAULT_ASSISTANT_MODEL;
    const effort = input.effort ?? DEFAULT_ASSISTANT_REASONING_EFFORT;
    try {
      const replay = await this.repository.findRequestForOwner(
        input.requestId,
        createdBy,
      );
      if (replay) {
        if (replay.thread.id !== threadId || replay.turn.sequence === 1) {
          throw new AssistantTurnConflictError(
            "The request id already belongs to a different assistant operation",
          );
        }
        assertIdempotentReplay(replay.turn, input, model, effort);
        return { created: false, turn: this.toTurnView(replay.turn) };
      }

      this.assertProviderConfigured(model);
      const persisted = await this.repository.appendTurn({
        threadId,
        createdBy,
        requestId: input.requestId,
        model,
        effort,
        content: input.content,
      });
      if (!persisted) {
        throw new AssistantThreadNotFoundError(threadId);
      }
      assertIdempotentReplay(persisted.turn, input, model, effort);
      return {
        created: persisted.created,
        turn: this.toTurnView(persisted.turn),
      };
    } catch (error) {
      if (
        error instanceof AssistantActiveTurnPersistenceError ||
        error instanceof AssistantRequestReplayPersistenceError
      ) {
        throw new AssistantTurnConflictError(error.message);
      }
      throw error;
    }
  }

  async list(createdBy: string): Promise<AssistantThreadListView> {
    const records = await this.repository.listThreadRecordsForOwner(createdBy);
    return {
      items: records.map(({ thread, turns }) => {
        const last = turns.at(-1);
        if (!last) {
          throw new Error("Assistant thread has no turns");
        }
        return {
          id: thread.id,
          title: thread.title,
          lastModel: last.model as AssistantModel,
          lastStatus: asTurnStatus(last.status),
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        };
      }),
    };
  }

  async getThread(id: string, createdBy: string): Promise<AssistantThreadView> {
    const record = await this.repository.findThreadRecordForOwner(
      id,
      createdBy,
    );
    if (!record) {
      throw new AssistantThreadNotFoundError(id);
    }
    return this.toThreadView(record);
  }

  async getTurn(
    threadId: string,
    turnId: string,
    createdBy: string,
  ): Promise<AssistantTurnView> {
    const turn = await this.repository.findTurnForOwner(
      threadId,
      turnId,
      createdBy,
    );
    if (!turn) {
      throw new AssistantTurnNotFoundError(turnId);
    }
    return this.toTurnView(turn);
  }

  async retryTurn(
    threadId: string,
    turnId: string,
    createdBy: string,
  ): Promise<AssistantTurnView> {
    const current = await this.repository.findTurnForOwner(
      threadId,
      turnId,
      createdBy,
    );
    if (!current) {
      throw new AssistantTurnNotFoundError(turnId);
    }
    this.assertProviderConfigured(current.model as AssistantModel);
    if (current.status !== "failed") {
      throw new AssistantTurnConflictError("Only a failed turn can be retried");
    }

    const turn = await this.repository.retryFailedTurn({
      threadId,
      turnId,
      createdBy,
    });
    if (!turn) {
      throw new AssistantTurnConflictError(
        "Only the latest failed turn can be retried",
      );
    }
    return this.toTurnView(turn);
  }

  async start(
    turnId: string,
    attempt: number,
  ): Promise<AssistantTurnExecution> {
    const current = await this.getTurnRow(turnId);
    if (
      current.attempt !== attempt ||
      current.status === "succeeded" ||
      current.status === "failed"
    ) {
      return { turn: current, messages: [] };
    }

    const running = await this.repository.markRunning(turnId, attempt);
    const turn = running ?? (await this.getTurnRow(turnId));
    if (turn.attempt !== attempt || turn.status !== "running") {
      return { turn, messages: [] };
    }

    const context = await this.repository.findContextTurns(turn);
    const messages: AssistantTurnExecution["messages"] = [];
    for (const item of context) {
      if (item.id === turn.id) {
        messages.push({ role: "user", content: item.userContent });
        continue;
      }
      if (item.status === "succeeded" && item.assistantContent) {
        messages.push({ role: "user", content: item.userContent });
        messages.push({ role: "assistant", content: item.assistantContent });
      }
    }
    return { turn, messages };
  }

  markQueued(id: string, attempt: number): Promise<void> {
    return this.repository.markQueued(id, attempt);
  }

  markSucceeded(id: string, attempt: number, response: string): Promise<void> {
    return this.repository.markSucceeded(id, attempt, response);
  }

  markFailed(
    id: string,
    attempt: number,
    code: AssistantFailureCode,
    message: string,
  ): Promise<boolean> {
    return this.repository.markFailed(id, attempt, code, message);
  }

  findStaleNonterminalTurns(
    staleBefore: Date,
    limit = 100,
  ): Promise<AssistantTurnRow[]> {
    return this.repository.findStaleNonterminalTurns(staleBefore, limit);
  }

  private async getTurnRow(id: string): Promise<AssistantTurnRow> {
    const turn = await this.repository.findTurnById(id);
    if (!turn) {
      throw new AssistantTurnNotFoundError(id);
    }
    return turn;
  }

  private assertProviderConfigured(model: AssistantModel): void {
    const adapter = assistantModelAdapter(model);
    const key =
      adapter.provider === "openrouter"
        ? this.config.get("OPENROUTER_API_KEY", { infer: true })
        : this.config.get("OPENAI_API_KEY", { infer: true });
    if (!key) {
      throw new AssistantProviderUnavailableError();
    }
  }

  private toThreadView(record: AssistantThreadRecord): AssistantThreadView {
    return {
      id: record.thread.id,
      title: record.thread.title,
      createdAt: record.thread.createdAt.toISOString(),
      updatedAt: record.thread.updatedAt.toISOString(),
      turns: record.turns.map((turn) => this.toTurnView(turn)),
    };
  }

  private toTurnView(turn: AssistantTurnRow): AssistantTurnView {
    const base = {
      id: turn.id,
      requestId: turn.requestId,
      sequence: turn.sequence,
      model: turn.model as AssistantModel,
      effort: turn.effort as AssistantReasoningEffort,
      user: { role: "user" as const, content: turn.userContent },
      attempt: turn.attempt,
      createdAt: turn.createdAt.toISOString(),
      startedAt: turn.startedAt?.toISOString() ?? null,
    };

    switch (turn.status) {
      case "queued":
      case "running":
        return {
          ...base,
          status: turn.status,
          assistant: null,
          error: null,
          completedAt: null,
        };
      case "succeeded":
        if (!turn.assistantContent || !turn.completedAt) {
          throw new Error(
            "Succeeded assistant turn has invalid persisted state",
          );
        }
        return {
          ...base,
          status: "succeeded",
          assistant: { role: "assistant", content: turn.assistantContent },
          error: null,
          completedAt: turn.completedAt.toISOString(),
        };
      case "failed":
        if (!turn.errorCode || !turn.errorMessage || !turn.completedAt) {
          throw new Error("Failed assistant turn has invalid persisted state");
        }
        return {
          ...base,
          status: "failed",
          assistant: null,
          error: {
            code: turn.errorCode as AssistantFailureCode,
            message: turn.errorMessage,
          },
          completedAt: turn.completedAt.toISOString(),
        };
      default:
        throw new Error("Assistant turn has unsupported persisted status");
    }
  }
}

function titleFromContent(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 80
    ? oneLine
    : `${oneLine.slice(0, 77).trimEnd()}...`;
}

function assertIdempotentReplay(
  turn: AssistantTurnRow,
  input: CreateAssistantTurnInput,
  model: AssistantModel,
  effort: AssistantReasoningEffort,
): void {
  if (
    turn.model !== model ||
    turn.effort !== effort ||
    turn.userContent !== input.content
  ) {
    throw new AssistantTurnConflictError(
      "The request id was already used with different turn content",
    );
  }
}

function asTurnStatus(value: string): AssistantTurnView["status"] {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error("Assistant turn has unsupported persisted status");
}
