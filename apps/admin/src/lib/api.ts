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

export function apiErrorMessage(cause: unknown, fallback: string): string {
  const responseMessage = isRecord(cause)
    ? apiMessage(isRecord(cause.data) ? cause.data.message : undefined)
    : undefined;

  return (
    responseMessage ??
    (cause instanceof Error ? apiMessage(cause.message) : undefined) ??
    fallback
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function apiMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const messages = value
      .filter((message): message is string => typeof message === "string")
      .map((message) => message.trim())
      .filter((message) => message !== "");
    return messages.length > 0 ? messages.join(" ") : undefined;
  }
  return undefined;
}
