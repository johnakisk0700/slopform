import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthConfigService } from "./auth-config.service.js";
import { AuthGuard } from "./auth.guard.js";
import { DEV_AUTH_USER_ID, getVerifiedUserId } from "./verified-principal.js";

const getAuthMock = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/express")>()),
  getAuth: getAuthMock,
}));

function createContext(
  request: Record<PropertyKey, unknown> = {},
): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function createGuard(options?: {
  readonly devBypassEnabled?: boolean;
  readonly isPublic?: boolean;
  readonly isAdmin?: boolean;
}): AuthGuard {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(options?.isPublic ?? false),
  } as unknown as Reflector;
  const authConfig = {
    devBypassEnabled: options?.devBypassEnabled ?? false,
    isAdminUser: vi.fn().mockReturnValue(options?.isAdmin ?? false),
  } as unknown as AuthConfigService;

  return new AuthGuard(reflector, authConfig);
}

describe("AuthGuard", () => {
  beforeEach(() => getAuthMock.mockReset());

  it("leaves only explicitly public controllers outside Clerk auth", () => {
    expect(createGuard({ isPublic: true }).canActivate(createContext())).toBe(
      true,
    );
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("returns 401 when no Clerk session is authenticated", () => {
    getAuthMock.mockReturnValue({ isAuthenticated: false, userId: null });

    expect(() => createGuard().canActivate(createContext())).toThrow(
      UnauthorizedException,
    );
  });

  it("returns 403 when a signed-in profile is not an approved admin", () => {
    getAuthMock.mockReturnValue({
      isAuthenticated: true,
      userId: "user_unapproved123",
    });

    expect(() => createGuard().canActivate(createContext())).toThrow(
      ForbiddenException,
    );
  });

  it("allows an authenticated subject in the server-side admin allowlist", () => {
    const request = {};
    getAuthMock.mockReturnValue({
      isAuthenticated: true,
      userId: "user_approved123",
    });

    expect(
      createGuard({ isAdmin: true }).canActivate(createContext(request)),
    ).toBe(true);
    expect(getVerifiedUserId(request as never)).toBe("user_approved123");
  });

  it("uses a fixed server-selected principal for the dev bypass", () => {
    const request = {};

    expect(
      createGuard({ devBypassEnabled: true }).canActivate(
        createContext(request),
      ),
    ).toBe(true);
    expect(getAuthMock).not.toHaveBeenCalled();
    expect(getVerifiedUserId(request as never)).toBe(DEV_AUTH_USER_ID);
  });
});
