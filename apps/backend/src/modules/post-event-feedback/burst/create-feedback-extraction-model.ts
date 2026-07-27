import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { PostEventFeedbackExtractionModel } from "../extraction/model.service.js";
import type { BurstPersona } from "./burst-scenario.js";
import { ScriptedBurstExtractionModel } from "./scripted-extraction-model.service.js";

const logger = new Logger("PostEventFeedbackExtractionModel");

/**
 * Chooses the real OpenRouter/OpenAI extraction model or the deterministic
 * burst stub. Called once at worker module construction.
 *
 * When the stub gate is on, the caller must pass the persona catalogue — the
 * factory stays free of a hard import so unit tests of the off path do not
 * depend on `burst-personas.ts`.
 */
export function createFeedbackExtractionModel(
  config: ConfigService<Environment, true>,
  personas?: readonly BurstPersona[],
): PostEventFeedbackExtractionModel | ScriptedBurstExtractionModel {
  if (config.get("FEEDBACK_EXTRACTION_STUB", { infer: true })) {
    if (!personas) {
      throw new Error(
        "FEEDBACK_EXTRACTION_STUB=true requires the burst persona catalogue",
      );
    }
    logger.warn(
      "FEEDBACK_EXTRACTION_STUB=true: worker extractions use ScriptedBurstExtractionModel — no provider is called",
    );
    return new ScriptedBurstExtractionModel(personas);
  }
  return new PostEventFeedbackExtractionModel(config);
}
