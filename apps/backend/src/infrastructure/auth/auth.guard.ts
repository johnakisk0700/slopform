import { getAuth } from "@clerk/express";
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { IS_PUBLIC_ROUTE } from "./public.decorator.js";
import { AuthConfigService } from "./auth-config.service.js";
import { DEV_AUTH_USER_ID, setVerifiedUserId } from "./verified-principal.js";

/** Authenticates every Nest HTTP controller unless its handler/class is public. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authConfig: AuthConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    if (this.authConfig.devBypassEnabled) {
      setVerifiedUserId(request, DEV_AUTH_USER_ID);
      return true;
    }

    const auth = getAuth(request, { acceptsToken: "session_token" });

    if (!auth.isAuthenticated || !auth.userId) {
      throw new UnauthorizedException("Authentication required");
    }

    if (!this.authConfig.isAdminUser(auth.userId)) {
      throw new ForbiddenException("Admin access required");
    }

    setVerifiedUserId(request, auth.userId);
    return true;
  }
}
