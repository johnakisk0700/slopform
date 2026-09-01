import { defineConfig } from "orval";

/**
 * Generates the admin API client from the backend contract.
 *
 * Input: `apps/backend/openapi/openapi.json`, written by
 * `pnpm --filter @slopform/backend openapi:emit`. Never edit the output;
 * run `pnpm api:generate` from the repository root, which regenerates the
 * document first. `pnpm api:check` fails the repository check when the
 * committed output no longer matches the contract.
 *
 * Two entries share one input: TanStack Query hooks named after the backend
 * `operationId`, and the matching Zod schemas for the rare place that needs to
 * validate a payload by hand (a form draft, a persisted value). Every request
 * goes through the `apiRequest` mutator, which is the shared `ofetch` client, so
 * the generated code adds no transport policy of its own.
 */
const formatGeneratedFiles = {
  // Generated files are committed and verified by `pnpm format:check`.
  afterAllFilesWrite: "prettier --write",
};

export default defineConfig({
  adminApi: {
    input: {
      target: "../backend/openapi/openapi.json",
      override: { transformer: "./openapi.transformer.ts" },
    },
    output: {
      client: "react-query",
      mode: "tags",
      target: "./src/api/generated/endpoints.ts",
      schemas: "./src/api/generated/model",
      indexFiles: false,
      clean: true,
      httpClient: "fetch",
      override: {
        mutator: { path: "./src/lib/api-mutator.ts", name: "apiRequest" },
        fetch: { includeHttpResponseReturnType: false },
        // GET becomes a query hook, everything else a mutation hook.
        query: { signal: true },
        useTypeOverInterfaces: true,
      },
    },
    hooks: formatGeneratedFiles,
  },
  adminApiZod: {
    input: {
      target: "../backend/openapi/openapi.json",
      override: { transformer: "./openapi.transformer.ts" },
    },
    output: {
      client: "zod",
      mode: "tags",
      target: "./src/api/generated/zod/schemas.ts",
      indexFiles: false,
      clean: true,
      fileExtension: ".zod.ts",
    },
    hooks: formatGeneratedFiles,
  },
});
