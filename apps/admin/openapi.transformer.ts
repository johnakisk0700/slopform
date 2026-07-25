/**
 * Rebases the published document onto the API client.
 *
 * The backend mounts every route under the `/api` prefix and publishes the full
 * path (`/api/v1/auth/session`). The shared `ofetch` client already carries that
 * mount point as `env.apiBase` (default `/api`, overridable with
 * `VITE_API_BASE`), so generated operations must use paths relative to it —
 * `/v1/auth/session` — exactly like hand-written calls.
 *
 * This runs at generation time only; the emitted `openapi.json` keeps the real
 * server paths.
 */
const API_MOUNT_PATH = "/api";

interface OpenApiDocument {
  readonly paths?: Record<string, unknown>;
}

export default function rebaseOnApiClient<T extends OpenApiDocument>(
  document: T,
): T {
  if (!document.paths) {
    return document;
  }

  const paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => {
      if (!path.startsWith(`${API_MOUNT_PATH}/`)) {
        throw new Error(
          `Expected every published path to start with "${API_MOUNT_PATH}/", received "${path}"`,
        );
      }

      return [path.slice(API_MOUNT_PATH.length), item];
    }),
  );

  return { ...document, paths };
}
