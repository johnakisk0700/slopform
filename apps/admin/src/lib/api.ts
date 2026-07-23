import { ofetch, type $Fetch } from "ofetch";

import { env } from "./env";

/**
 * The single HTTP client for the admin SPA.
 *
 * Ported from the Nuxt `$fetch.create` seam (apps/web/app/plugins/api.ts). This
 * is a client-only SPA, so all SSR request-header forwarding is dropped — the
 * browser attaches the session cookie itself. `credentials: "include"` sends it
 * on every call (the backend trusts this origin for CORS); `retry: 0` keeps
 * mutations from double-firing; the 15s timeout mirrors the old client.
 */
export const api: $Fetch = ofetch.create({
  baseURL: env.apiBase,
  credentials: "include",
  retry: 0,
  timeout: 15_000,
});

/** The type of the shared API client, for typing facades and callers. */
export type ApiClient = typeof api;
