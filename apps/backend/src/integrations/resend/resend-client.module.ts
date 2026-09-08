import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";
import { ResendClient } from "./resend.client.js";

/** Provider-only module. The worker conditionally imports it when configured. */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ResendClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => {
        const apiKey = config.get("RESEND_API_KEY", { infer: true });
        const fromEmail = config.get("RESEND_FROM_EMAIL", { infer: true });

        if (!apiKey || !fromEmail) {
          throw new Error(
            "RESEND_API_KEY and RESEND_FROM_EMAIL are required when Resend is enabled",
          );
        }

        return new ResendClient({
          apiKey,
          fromEmail,
        });
      },
    },
  ],
  exports: [ResendClient],
})
export class ResendClientModule {}
