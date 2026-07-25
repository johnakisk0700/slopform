import { createClerkClient, type ClerkClient } from "@clerk/express";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Environment } from "../config/environment.js";

/**
 * HTTP-only Clerk configuration. The shared environment schema accepts absent
 * Clerk keys so the worker can start without receiving the API secret; importing
 * AuthModule makes both keys mandatory for the HTTP process.
 */
@Injectable()
export class AuthConfigService {
  readonly authorizedParties: readonly string[];
  readonly clerkClient: ClerkClient | undefined;
  readonly devBypassEnabled: boolean;
  readonly #adminUserIds: ReadonlySet<string>;

  constructor(config: ConfigService<Environment, true>) {
    const publishableKey = config.get("CLERK_PUBLISHABLE_KEY", { infer: true });
    const secretKey = config.get("CLERK_SECRET_KEY", { infer: true });
    const adminUserIds = config.get("CLERK_ADMIN_USER_IDS", { infer: true });
    this.devBypassEnabled = config.get("AUTH_DEV_BYPASS", { infer: true });

    this.authorizedParties = config.get("WEB_ORIGIN", { infer: true });
    this.#adminUserIds = new Set(adminUserIds ?? []);

    if (this.devBypassEnabled) {
      this.clerkClient = undefined;
      return;
    }

    if (!publishableKey || !secretKey || !adminUserIds?.length) {
      throw new Error(
        "CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY and CLERK_ADMIN_USER_IDS are required by the HTTP authentication boundary",
      );
    }

    this.clerkClient = createClerkClient({ publishableKey, secretKey });
  }

  isAdminUser(userId: string): boolean {
    return this.#adminUserIds.has(userId);
  }
}
