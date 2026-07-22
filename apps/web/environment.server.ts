import { z } from "zod";

import {
  publicApiBaseSchema,
  validatePublicEnvironment,
} from "./environment.public.js";

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const internalApiBaseSchema = z.url().refine((value) => {
  const url = parseUrl(value);

  return Boolean(
    url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
  );
}, "Expected an HTTP(S) URL without credentials, query or fragment");

export const webEnvironmentSchema = z.object({
  NUXT_API_BASE_INTERNAL: z.preprocess(
    emptyStringToUndefined,
    internalApiBaseSchema.default("http://localhost:4000/api/v1"),
  ),
  NUXT_PUBLIC_API_BASE: z.preprocess(
    emptyStringToUndefined,
    publicApiBaseSchema.default("/api/v1"),
  ),
});

const webRuntimeConfigSchema = z.object({
  apiBaseInternal: internalApiBaseSchema,
  public: z.unknown(),
});

export type WebEnvironment = z.infer<typeof webEnvironmentSchema>;

export function validateWebEnvironment(
  input: Record<string, unknown>,
): WebEnvironment {
  return webEnvironmentSchema.parse(input);
}

export function validateWebRuntimeConfig(input: unknown): void {
  const runtimeConfig = webRuntimeConfigSchema.parse(input);
  validatePublicEnvironment(runtimeConfig.public);
}
