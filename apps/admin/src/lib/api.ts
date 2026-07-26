import { getToken } from "@clerk/react";
import { ofetch, type $Fetch } from "ofetch";

import { env } from "./env";

/**
 * The single HTTP client for the admin SPA.
 *
 * Ported from the Nuxt `$fetch.create` seam (apps/web/app/plugins/api.ts). This
 * is a client-only SPA, so all SSR request-header forwarding is dropped — the
 * Clerk's current session token is attached as a Bearer credential before each
 * request. `credentials: "include"` preserves Clerk's same-origin cookie flow;
 * `retry: 0` keeps mutations from double-firing; the 15s timeout mirrors the old
 * client.
 */
export const api: $Fetch = ofetch.create({
  baseURL: env.apiBase,
  credentials: "include",
  async onRequest({ options }) {
    const token = env.authDevBypass ? null : await getToken();
    options.headers = createApiHeaders(options.headers, token);
  },
  retry: 0,
  timeout: 15_000,
});

/** Builds an isolated header set and never preserves a caller-supplied bearer. */
function createApiHeaders(
  input: HeadersInit | undefined,
  token: string | null,
): Headers {
  const headers = new Headers(input);
  headers.delete("Authorization");

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}
