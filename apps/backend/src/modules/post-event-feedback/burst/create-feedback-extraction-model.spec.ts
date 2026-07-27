import { describe, expect, it, vi } from "vitest";

import { validateEnvironment } from "../../../infrastructure/config/environment.js";
import { PostEventFeedbackExtractionModel } from "../extraction/model.service.js";
import { createFeedbackExtractionModel } from "./create-feedback-extraction-model.js";
import { ScriptedBurstExtractionModel } from "./scripted-extraction-model.service.js";

describe("feedback extraction stub composition", () => {
  it("keeps the extraction stub out of production composition", () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: "postgresql://user:password@localhost:5432/join_the_six",
        MONGODB_URI: "mongodb://localhost:27017/join_the_six",
        NODE_ENV: "production",
        WEB_ORIGIN: "https://admin.example.com",
        TRANSPORT_MODE: "wasender",
        WASENDER_SESSION_API_KEY: "session-key",
        FEEDBACK_EXTRACTION_STUB: "true",
      }),
    ).toThrow(/FEEDBACK_EXTRACTION_STUB cannot be enabled in production/);
  });

  it("returns the real extraction model when the stub gate is off", () => {
    const config = {
      get: vi.fn((key: string) => {
        if (key === "FEEDBACK_EXTRACTION_STUB") {
          return false;
        }
        if (key === "FEEDBACK_EXTRACTION_MODEL") {
          return undefined;
        }
        if (key === "OPENAI_API_KEY" || key === "OPENROUTER_API_KEY") {
          return undefined;
        }
        return undefined;
      }),
    };

    const model = createFeedbackExtractionModel(config as never);
    expect(model).toBeInstanceOf(PostEventFeedbackExtractionModel);
    expect(model).not.toBeInstanceOf(ScriptedBurstExtractionModel);
  });
});
