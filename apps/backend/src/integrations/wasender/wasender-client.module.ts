import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";
import { WasenderClient } from "./wasender.client.js";

/** Provider-only module for worker/domain composition. It has no HTTP adapter. */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: WasenderClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => {
        const apiKey = config.get("WASENDER_SESSION_API_KEY", { infer: true });

        if (!apiKey) {
          throw new Error(
            "WASENDER_SESSION_API_KEY is required when the Wasender transport is enabled",
          );
        }

        return new WasenderClient({ apiKey });
      },
    },
  ],
  exports: [WasenderClient],
})
export class WasenderClientModule {}
