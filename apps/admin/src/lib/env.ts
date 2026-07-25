import * as z from "zod";

/**
 * Client environment for the admin SPA.
 *
 * Vite exposes only `import.meta.env.VITE_*` to the browser bundle. We validate
 * the API base and Clerk publishable key with explicit schemas. Invalid values
 * fail fast with a readable message; an absent Clerk key is represented
 * explicitly so the entrypoint can render a configuration screen.
 *
 * `VITE_API_BASE` is optional: it defaults to `/api`, which the Vite dev proxy
 * (vite.config.ts) and the production Caddy reverse proxy both route to the
 * backend, so same-origin cookies work in every environment.
 */

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

const apiBaseSchema = z
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
  }, "Expected a root-relative path or an HTTP(S) URL without credentials, query or fragment")
  .default("/api");

const optionalClerkPublishableKeySchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .string()
    .trim()
    .regex(/^pk_(?:test|live)_/u, "Expected a Clerk publishable key")
    .optional(),
);

const booleanEnvironmentSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
);

const envSchema = z
  .object({
    apiBase: apiBaseSchema,
    authDevBypass: booleanEnvironmentSchema,
    clerkPublishableKey: optionalClerkPublishableKeySchema,
    isDevelopment: z.boolean(),
  })
  .superRefine((environment, context) => {
    if (environment.authDevBypass && !environment.isDevelopment) {
      context.addIssue({
        code: "custom",
        message:
          "VITE_AUTH_DEV_BYPASS cannot be enabled outside Vite development mode",
        path: ["authDevBypass"],
      });
    }
  });

export interface Env {
  apiBase: string;
  authDevBypass: boolean;
  clerkPublishableKey?: string | undefined;
}

export function validateEnv(input: {
  readonly DEV: unknown;
  readonly VITE_API_BASE: unknown;
  readonly VITE_AUTH_DEV_BYPASS: unknown;
  readonly VITE_CLERK_PUBLISHABLE_KEY: unknown;
}): Env {
  const result = envSchema.safeParse({
    apiBase: input.VITE_API_BASE,
    authDevBypass: input.VITE_AUTH_DEV_BYPASS,
    clerkPublishableKey: input.VITE_CLERK_PUBLISHABLE_KEY,
    isDevelopment: input.DEV,
  });

  if (!result.success) {
    const detail = z.prettifyError(result.error);
    throw new Error(`Invalid admin environment:\n${detail}`);
  }

  return {
    apiBase: result.data.apiBase,
    authDevBypass: result.data.authDevBypass,
    clerkPublishableKey: result.data.clerkPublishableKey,
  };
}

export const env: Env = validateEnv({
  DEV: import.meta.env.DEV,
  VITE_API_BASE: import.meta.env.VITE_API_BASE,
  VITE_AUTH_DEV_BYPASS: import.meta.env.VITE_AUTH_DEV_BYPASS,
  VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
});
