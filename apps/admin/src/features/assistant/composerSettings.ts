import {
  DEFAULT_ASSISTANT_EFFORT,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_SERVICE_TIER,
  isAssistantEffort,
  isAssistantModel,
  isAssistantServiceTier,
  type AssistantEffort,
  type AssistantModel,
  type AssistantServiceTier,
} from "./schema";

export const MODEL_STORAGE_KEY = "jts-assistant-model";
export const EFFORT_STORAGE_KEY = "jts-assistant-effort";
export const SERVICE_TIER_STORAGE_KEY = "jts-assistant-service-tier";

export function readSavedModel(): AssistantModel {
  try {
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    return isAssistantModel(saved) ? saved : DEFAULT_ASSISTANT_MODEL;
  } catch {
    return DEFAULT_ASSISTANT_MODEL;
  }
}

export function readSavedEffort(): AssistantEffort {
  try {
    const saved = localStorage.getItem(EFFORT_STORAGE_KEY);
    return isAssistantEffort(saved) ? saved : DEFAULT_ASSISTANT_EFFORT;
  } catch {
    return DEFAULT_ASSISTANT_EFFORT;
  }
}

/**
 * Remembered like model and effort, and for the same reason — but note the two
 * are not equally forgiving. A remembered effort costs a little more thinking;
 * a remembered fast lane doubles every bill until somebody notices, which is why
 * the turn records the tier it actually ran under rather than trusting this.
 */
export function readSavedServiceTier(): AssistantServiceTier {
  try {
    const saved = localStorage.getItem(SERVICE_TIER_STORAGE_KEY);
    return isAssistantServiceTier(saved)
      ? saved
      : DEFAULT_ASSISTANT_SERVICE_TIER;
  } catch {
    return DEFAULT_ASSISTANT_SERVICE_TIER;
  }
}
