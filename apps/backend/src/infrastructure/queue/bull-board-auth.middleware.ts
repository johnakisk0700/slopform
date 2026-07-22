import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

function safelyEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function protectBullBoard(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (process.env.BULL_BOARD_ENABLED !== "true") {
    response.sendStatus(404);
    return;
  }

  const authorization = request.header("authorization");
  const [scheme, encodedCredentials] = authorization?.split(" ") ?? [];

  if (scheme !== "Basic" || !encodedCredentials) {
    response.setHeader("www-authenticate", 'Basic realm="Join The Six queues"');
    response.sendStatus(401);
    return;
  }

  const separatorIndex = Buffer.from(encodedCredentials, "base64")
    .toString("utf8")
    .indexOf(":");
  const decodedCredentials = Buffer.from(encodedCredentials, "base64").toString(
    "utf8",
  );
  const username =
    separatorIndex >= 0 ? decodedCredentials.slice(0, separatorIndex) : "";
  const password =
    separatorIndex >= 0 ? decodedCredentials.slice(separatorIndex + 1) : "";
  const expectedUsername = process.env.BULL_BOARD_USERNAME ?? "";
  const expectedPassword = process.env.BULL_BOARD_PASSWORD ?? "";

  if (
    !safelyEqual(username, expectedUsername) ||
    !safelyEqual(password, expectedPassword)
  ) {
    response.setHeader("www-authenticate", 'Basic realm="Join The Six queues"');
    response.sendStatus(401);
    return;
  }

  next();
}
