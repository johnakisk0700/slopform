import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  AssistantEnqueueError,
  type AssistantJobsService,
} from "./assistant-jobs.service.js";
import { AssistantController } from "./assistant.controller.js";
import {
  AssistantProviderUnavailableError,
  type AssistantService,
  AssistantThreadNotFoundError,
  AssistantTurnConflictError,
} from "./assistant.service.js";
import type { AssistantStreamRelay } from "./assistant-stream.relay.js";

const threadId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const requestId = "a8e94f93-9909-4cf2-b580-3b55c287a452";

describe("AssistantController", () => {
  it("passes only the verified principal to owner-scoped reads", async () => {
    const assistant = {
      getThread: vi
        .fn()
        .mockRejectedValue(new AssistantThreadNotFoundError(threadId)),
    } as unknown as AssistantService;
    const controller = new AssistantController(
      assistant,
      {} as AssistantJobsService,
      {} as AssistantStreamRelay,
    );

    await expect(
      controller.getThread({ id: threadId }, "user_verified" as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(assistant.getThread).toHaveBeenCalledWith(threadId, "user_verified");
  });

  it.each([
    new AssistantProviderUnavailableError(),
    new AssistantEnqueueError(),
  ])("maps unavailable creation dependencies to HTTP 503", async (failure) => {
    const jobs = {
      createThreadAndEnqueue: vi.fn().mockRejectedValue(failure),
    } as unknown as AssistantJobsService;
    const controller = new AssistantController(
      {} as AssistantService,
      jobs,
      {} as AssistantStreamRelay,
    );

    await expect(
      controller.createThread(
        { requestId, effort: "low", serviceTier: "standard", content: "Hello" },
        "user_verified" as never,
        "request-1" as never,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("maps active-turn conflicts to HTTP 409", async () => {
    const jobs = {
      appendTurnAndEnqueue: vi
        .fn()
        .mockRejectedValue(new AssistantTurnConflictError()),
    } as unknown as AssistantJobsService;
    const controller = new AssistantController(
      {} as AssistantService,
      jobs,
      {} as AssistantStreamRelay,
    );

    await expect(
      controller.appendTurn(
        { id: threadId },
        { requestId, effort: "low", serviceTier: "standard", content: "Hello" },
        "user_verified" as never,
        "request-1" as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
