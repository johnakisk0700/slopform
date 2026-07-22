import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ReferenceJobsService } from "./reference-jobs.service.js";
import { ReferenceController } from "./reference.controller.js";
import {
  ReferenceRecordNotFoundError,
  type ReferenceService,
} from "./reference.service.js";

describe("ReferenceController", () => {
  it("maps the application not-found error to HTTP 404", async () => {
    const recordId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
    const references = {
      get: vi
        .fn()
        .mockRejectedValue(new ReferenceRecordNotFoundError(recordId)),
    } as unknown as ReferenceService;
    const controller = new ReferenceController(
      references,
      {} as ReferenceJobsService,
    );

    await expect(controller.get({ id: recordId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
