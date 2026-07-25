import type { Request } from "express";

export const DEV_AUTH_USER_ID = "user_localdev";

const VERIFIED_USER_ID = Symbol("join-the-six.verified-user-id");

type RequestWithVerifiedPrincipal = Request & {
  [VERIFIED_USER_ID]?: string;
};

/** Stores the principal only after the global guard has authenticated it. */
export function setVerifiedUserId(request: Request, userId: string): void {
  (request as RequestWithVerifiedPrincipal)[VERIFIED_USER_ID] = userId;
}

/** Reads the principal established by the global guard for controller use. */
export function getVerifiedUserId(request: Request): string | undefined {
  return (request as RequestWithVerifiedPrincipal)[VERIFIED_USER_ID];
}
