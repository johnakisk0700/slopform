import { randomBytes } from "node:crypto";

import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FEEDBACK_OPERATION_EVENT,
  FeedbackLogger,
  FeedbackOperationLog,
} from "./feedback-operation-log.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeedbackLogger", () => {
  it("lets the caller finish when the sink throws", () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => {
      throw new Error("pino unavailable");
    });
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => {
      throw new Error("pino unavailable");
    });

    const logger = new FeedbackLogger("FeedbackOperationLogSpec");
    const operation = new FeedbackOperationLog(logger, {
      operation: "extract",
      correlationId: "corr-1",
      conversationId: "conv-1",
    });

    expect(() => {
      logger.log({ event: "probe" });
      operation.stage("admit");
      operation.complete("extracted");
    }).not.toThrow();
  });
});

describe("FeedbackOperationLog", () => {
  it("keeps logging observational when its entropy source fails", () => {
    const records = capture();
    const failEntropy = () => {
      throw new Error("entropy unavailable");
    };
    vi.mocked(randomBytes)
      .mockImplementationOnce(failEntropy)
      .mockImplementationOnce(failEntropy);

    for (let index = 0; index < 2; index += 1) {
      const operation = new FeedbackOperationLog(records.logger, {
        operation: "dispatch",
        correlationId: "same-outbox",
      });
      operation.stage("transport");
      operation.complete("sent");
    }

    const completed = records.emitted.filter(
      (record) => record.status === "completed",
    );
    expect(completed).toHaveLength(2);
    expect(completed[0]?.runId).not.toBe(completed[1]?.runId);
    expect(completed.every((record) => record.outcome === "sent")).toBe(true);
  });

  it("preserves the original business error when fail logging throws", () => {
    const business = new TypeError("capacity token sk-live");
    const logger = {
      log() {},
      error() {
        throw new Error("sink");
      },
    };
    const operation = new FeedbackOperationLog(logger, {
      operation: "extract",
      correlationId: "corr-1",
    });

    try {
      operation.stage("commit");
      throw business;
    } catch (error) {
      operation.failed(error);
      expect(error).toBe(business);
    }
  });

  it("keeps interleaved operations on distinct run ids and stages", () => {
    const records = capture();
    const extract = new FeedbackOperationLog(records.logger, {
      operation: "extract",
      correlationId: "corr-a",
      conversationId: "conv-1",
    });
    const dispatch = new FeedbackOperationLog(records.logger, {
      operation: "dispatch",
      correlationId: "corr-b",
      outboxId: "out-1",
    });

    extract.stage("admit");
    dispatch.stage("claim");
    extract.stage("commit");
    dispatch.complete("accepted");
    extract.complete("extracted");

    const extractRun = records.emitted[0]?.runId;
    const dispatchRun = records.emitted[1]?.runId;
    expect(extractRun).toEqual(expect.any(String));
    expect(dispatchRun).toEqual(expect.any(String));
    expect(extractRun).not.toBe(dispatchRun);
    expect(
      records.emitted
        .filter((record) => record.runId === extractRun)
        .map((record) => [record.stage, record.status]),
    ).toEqual([
      ["admit", "started"],
      ["commit", "started"],
      ["commit", "completed"],
    ]);
    expect(
      records.emitted
        .filter((record) => record.runId === dispatchRun)
        .map((record) => [record.stage, record.status]),
    ).toEqual([
      ["claim", "started"],
      ["claim", "completed"],
    ]);
  });

  it("omits raw messages, bodies, and secrets from failed records", () => {
    const records = capture();
    const operation = new FeedbackOperationLog(records.logger, {
      operation: "extract",
      correlationId: "corr-1",
    });
    const hostile = {
      get name() {
        throw new Error("getter");
      },
      get message() {
        return "Authorization: Bearer sk-live";
      },
      get code() {
        return 306900000001;
      },
      body: { password: "hunter2", token: "tok" },
    };

    operation.stage("commit");
    expect(() => {
      operation.failed(hostile);
      operation.failed("Authorization: Bearer sk-live");
    }).not.toThrow();

    const serialized = JSON.stringify(records.emitted);
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("306900000001");
    for (const record of records.emitted) {
      expect(record).not.toHaveProperty("message");
      expect(record).not.toHaveProperty("stack");
      expect(record).not.toHaveProperty("body");
      expect(record).not.toHaveProperty("cause");
    }
  });

  it("names the exact last stage and outcome on the terminal record", () => {
    const records = capture();
    const operation = new FeedbackOperationLog(records.logger, {
      operation: "extract",
      correlationId: "corr-1",
      conversationId: "conv-1",
      workRevision: 4,
      executionEpoch: 8,
      attempt: 2,
    });
    const failure = Object.assign(new TypeError("do not log this body"), {
      code: 23505,
    });

    operation.stage("admit");
    operation.enrich({ ingressId: "ing-1" });
    operation.stage("commit");
    operation.failed(failure, "superseded");
    operation.complete("extracted");

    const terminal = records.emitted.at(-1);
    expect(terminal).toMatchObject({
      event: FEEDBACK_OPERATION_EVENT,
      operation: "extract",
      stage: "commit",
      status: "failed",
      outcome: "superseded",
      errorName: "TypeError",
      errorCode: "23505",
      conversationId: "conv-1",
      ingressId: "ing-1",
      workRevision: 4,
      executionEpoch: 8,
      attempt: 2,
    });
    expect(terminal?.elapsedMs).toEqual(expect.any(Number));
    expect(
      records.emitted.filter((record) => record.status !== "started"),
    ).toHaveLength(1);
  });
});

function capture(): {
  readonly logger: {
    log(message: unknown): void;
    error(message: unknown): void;
  };
  readonly emitted: Record<string, unknown>[];
} {
  const emitted: Record<string, unknown>[] = [];
  return {
    emitted,
    logger: {
      log(message: unknown) {
        emitted.push(message as Record<string, unknown>);
      },
      error(message: unknown) {
        emitted.push(message as Record<string, unknown>);
      },
    },
  };
}
