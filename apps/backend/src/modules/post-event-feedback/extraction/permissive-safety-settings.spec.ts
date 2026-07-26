import { describe, expect, it } from "vitest";

import { assistantModelAdapter } from "../../assistant/assistant-models.js";
import {
  FEEDBACK_EXTRACTION_PERMISSIVE_SAFETY_SETTINGS,
  resolveFeedbackExtractionProviderSettings,
} from "./permissive-safety-settings.js";

describe("feedback extraction provider safety settings", () => {
  it("relaxes the thresholds for the default Gemini extraction model", () => {
    const settings = resolveFeedbackExtractionProviderSettings(
      assistantModelAdapter("google/gemini-3.6-flash"),
    );

    // Sent through the OpenRouter chat model's `extraBody` passthrough, which
    // forwards unrecognised body fields to the upstream provider.
    expect(settings?.extraBody).toEqual({
      safety_settings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
      ],
    });
  });

  it.each([
    ["qwen/qwen3.7-max", "an OpenRouter model that is not Google"],
    ["openai/gpt-5.6-luna", "a direct OpenAI model"],
    ["openai/gpt-5.6-terra", "a direct OpenAI model"],
  ] as const)("sends nothing for %s (%s)", (model, _reason) => {
    // `safety_settings` is Google-specific; forwarding it elsewhere would be
    // noise at best and a rejected request at worst.
    expect(
      resolveFeedbackExtractionProviderSettings(assistantModelAdapter(model)),
    ).toBeUndefined();
  });

  it("hands out a fresh copy so a caller cannot mutate the constant", () => {
    const first = resolveFeedbackExtractionProviderSettings(
      assistantModelAdapter("google/gemini-3.6-flash"),
    );
    const settings = first?.extraBody["safety_settings"] as {
      threshold: string;
    }[];
    settings[0]!.threshold = "BLOCK_ALL";

    expect(FEEDBACK_EXTRACTION_PERMISSIVE_SAFETY_SETTINGS[0].threshold).toBe(
      "BLOCK_NONE",
    );
  });
});
