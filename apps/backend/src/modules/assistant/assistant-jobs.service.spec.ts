import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { AssistantJobsService } from "./assistant-jobs.service.js";
import {
  ASSISTANT_JOB_NAMES,
  type AssistantJobData,
  type AssistantJobName,
  type AssistantThreadView,
  type AssistantTurnView,
} from "./assistant.schemas.js";
import type { AssistantService } from "./assistant.service.js";

const threadId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const turnId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const requestId = "a8e94f93-9909-4cf2-b580-3b55c287a452";
const turn: AssistantTurnView = {
  id: turnId,
  requestId,
  sequence: 1,
  status: "queued",
  model: "google/gemini-3.6-flash",
  effort: "low",
  user: { role: "user", content: "Hello" },
  assistant: null,
  error: null,
  attempt: 1,
  createdAt: "2026-07-23T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
};
const thread: AssistantThreadView = {
  id: threadId,
  title: "Hello",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
  turns: [turn],
};

describe("AssistantJobsService", () => {
  it("persists first and enqueues only the turn identifier", async () => {
    const queue = {
      add: vi
        .fn()
        .mockResolvedValue({ id: `assistant-generate-v2-${turnId}-1` }),
    } as unknown as Queue<AssistantJobData, void, AssistantJobName>;
    const assistant = {
      createThread: vi.fn().mockResolvedValue({ created: true, thread, turn }),
      markFailed: vi.fn(),
    } as unknown as AssistantService;
    const jobs = new AssistantJobsService(queue, assistant);

    await expect(
      jobs.createThreadAndEnqueue(
        { requestId, content: "Hello" },
        "user_owner",
        "request-1",
      ),
    ).resolves.toEqual(thread);
    expect(queue.add).toHaveBeenCalledWith(
      ASSISTANT_JOB_NAMES.generateTurnV2,
      { schemaVersion: 2, turnId, correlationId: "request-1" },
      { jobId: `assistant-generate-v2-${turnId}-1` },
    );
  });

  it("does not enqueue an idempotent HTTP replay twice", async () => {
    const queue = { add: vi.fn() } as unknown as Queue<
      AssistantJobData,
      void,
      AssistantJobName
    >;
    const assistant = {
      appendTurn: vi.fn().mockResolvedValue({ created: false, turn }),
    } as unknown as AssistantService;
    const jobs = new AssistantJobsService(queue, assistant);

    await expect(
      jobs.appendTurnAndEnqueue(
        threadId,
        { requestId, content: "Hello" },
        "user_owner",
        "request-2",
      ),
    ).resolves.toEqual(turn);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("marks the exact authoritative attempt failed when enqueueing fails", async () => {
    const queue = {
      add: vi.fn().mockRejectedValue(new Error("redis secret")),
    } as unknown as Queue<AssistantJobData, void, AssistantJobName>;
    const assistant = {
      createThread: vi.fn().mockResolvedValue({ created: true, thread, turn }),
      markFailed: vi.fn().mockResolvedValue(undefined),
    } as unknown as AssistantService;
    const jobs = new AssistantJobsService(queue, assistant);

    await expect(
      jobs.createThreadAndEnqueue(
        { requestId, content: "Hello" },
        "user_owner",
        "request-1",
      ),
    ).rejects.toThrow("could not be queued");
    expect(assistant.markFailed).toHaveBeenCalledWith(
      turnId,
      1,
      "generation_failed",
      "The assistant turn could not be queued.",
    );
  });
});
