import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { createBullBoardAuthMiddleware } from "./bull-board-auth.middleware.js";

function createRequest(authorization?: string): Request {
  return {
    header: vi.fn((name: string) =>
      name === "authorization" ? authorization : undefined,
    ),
  } as unknown as Request;
}

function createResponse(): {
  readonly response: Response;
  readonly sendStatus: ReturnType<typeof vi.fn>;
  readonly setHeader: ReturnType<typeof vi.fn>;
} {
  const sendStatus = vi.fn();
  const setHeader = vi.fn();

  return {
    response: { sendStatus, setHeader } as unknown as Response,
    sendStatus,
    setHeader,
  };
}

describe("createBullBoardAuthMiddleware", () => {
  const middleware = createBullBoardAuthMiddleware({
    username: "operator",
    password: "secret:with-colon",
  });

  it("accepts the configured Basic credentials", () => {
    const encoded = Buffer.from("operator:secret:with-colon").toString(
      "base64",
    );
    const { response, sendStatus } = createResponse();
    const next = vi.fn() as NextFunction;

    middleware(createRequest(`basic ${encoded}`), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(sendStatus).not.toHaveBeenCalled();
  });

  it("challenges missing or incorrect credentials", () => {
    const encoded = Buffer.from("operator:not-the-secret").toString("base64");
    const { response, sendStatus, setHeader } = createResponse();
    const next = vi.fn() as NextFunction;

    middleware(createRequest(`Basic ${encoded}`), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith(
      "www-authenticate",
      'Basic realm="Join The Six queues"',
    );
    expect(sendStatus).toHaveBeenCalledWith(401);
  });
});
