import { api } from "./api";

/**
 * The orval mutator: the only bridge between generated operations and HTTP.
 *
 * Every generated function calls this one, which delegates to the single
 * `ofetch` client in `./api.ts`, so the Clerk bearer, `credentials: "include"`,
 * `retry: 0` and the 15s timeout apply to generated and hand-written calls
 * alike. Only the four request fields orval produces cross the seam; transport
 * policy stays in `api.ts` and is never re-declared per operation.
 *
 * Generated paths omit the `/api` mount point (see `openapi.transformer.ts`)
 * because the client's `baseURL` (`env.apiBase`) owns it.
 */
export function apiRequest<TResponse>(
  url: string,
  init: RequestInit = {},
): Promise<TResponse> {
  const { body, headers, method, signal } = init;

  return api<TResponse>(url, {
    ...(body === null || body === undefined ? {} : { body }),
    ...(headers ? { headers } : {}),
    ...(method ? { method } : {}),
    ...(signal ? { signal } : {}),
  });
}
