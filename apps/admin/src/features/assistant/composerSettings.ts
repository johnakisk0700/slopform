import {
  DEFAULT_ASSISTANT_EFFORT,
  DEFAULT_ASSISTANT_MODEL,
  isAssistantEffort,
  isAssistantModel,
  type AssistantEffort,
  type AssistantModel,
} from "./schema";

export const MODEL_STORAGE_KEY = "jts-assistant-model";
export const EFFORT_STORAGE_KEY = "jts-assistant-effort";

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
