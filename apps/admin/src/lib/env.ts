import * as z from "zod";

/**
 * Client environment for the admin SPA.
 *
 * Vite exposes only `import.meta.env.VITE_*` to the browser bundle. We validate
 * the one value we consume — the API base — with the same safety rules the Nuxt
 * app enforced (root-relative path, or an HTTP(S) URL carrying no credentials,
 * query or fragment) and fail fast with a readable message at module load so a
 * misconfigured deploy never ships a silently-broken client.
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

const envSchema = z.object({
  apiBase: apiBaseSchema,
});

export interface Env {
  apiBase: string;
}

function validateEnv(): Env {
  const result = envSchema.safeParse({
    apiBase: import.meta.env.VITE_API_BASE,
  });

  if (!result.success) {
    const detail = z.prettifyError(result.error);
    throw new Error(`Invalid admin environment (VITE_API_BASE):\n${detail}`);
  }

  return result.data;
}

export const env: Env = validateEnv();
