import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { getVerifiedUserId } from "./verified-principal.js";

/** Supplies the verified Clerk subject; request DTOs never choose resource owners. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = getVerifiedUserId(request);

    if (!userId) {
      throw new UnauthorizedException("Authentication required");
    }

    return userId;
  },
);
