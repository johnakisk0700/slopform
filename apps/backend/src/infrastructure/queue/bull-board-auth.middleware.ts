import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

export interface BullBoardCredentials {
  readonly username: string;
  readonly password: string;
}

function safelyEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function createBullBoardAuthMiddleware(
  expected: BullBoardCredentials,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next): void => {
    setDashboardSecurityHeaders(response);

    const authorization = request.header("authorization");
    const authorizationParts = authorization?.split(" ") ?? [];
    const [scheme, encodedCredentials] = authorizationParts;

    if (
      authorizationParts.length !== 2 ||
      scheme?.toLowerCase() !== "basic" ||
      !encodedCredentials
    ) {
      denyAccess(response);
      return;
    }

    const decodedCredentials = Buffer.from(
      encodedCredentials,
      "base64",
    ).toString("utf8");
    const separatorIndex = decodedCredentials.indexOf(":");
    const username =
      separatorIndex >= 0 ? decodedCredentials.slice(0, separatorIndex) : "";
    const password =
      separatorIndex >= 0 ? decodedCredentials.slice(separatorIndex + 1) : "";

    if (
      !safelyEqual(username, expected.username) ||
      !safelyEqual(password, expected.password)
    ) {
      denyAccess(response);
      return;
    }

    next();
  };
}

function setDashboardSecurityHeaders(response: Response): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function denyAccess(response: Response): void {
  response.setHeader("www-authenticate", 'Basic realm="Slopform queues"');
  response.sendStatus(401);
}
