import { z } from "zod";

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const isSafeAbsoluteHttpUrl = (value: string): boolean => {
  const url = parseUrl(value);

  return Boolean(
    url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
  );
};

export const publicApiBaseSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    if (value.startsWith("/")) {
      return (
        !value.startsWith("//") && !value.includes("?") && !value.includes("#")
      );
    }

    return isSafeAbsoluteHttpUrl(value);
  }, "Expected a root-relative path or an HTTP(S) URL without credentials, query or fragment");

const publicRuntimeConfigSchema = z.object({
  apiBase: publicApiBaseSchema,
});

export type PublicEnvironment = z.infer<typeof publicRuntimeConfigSchema>;

export function validatePublicEnvironment(input: unknown): PublicEnvironment {
  return publicRuntimeConfigSchema.parse(input);
}
