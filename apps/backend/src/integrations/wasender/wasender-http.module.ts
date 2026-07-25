import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";
import { PostEventFeedbackIngressModule } from "../../modules/post-event-feedback/post-event-feedback-ingress.module.js";
import { WasenderWebhookController } from "./wasender.controller.js";
import { WasenderWebhookParser } from "./wasender.webhook.js";
import { WasenderWebhookSignatureVerifier } from "./wasender.webhook.js";

@Module({
  imports: [ConfigModule, PostEventFeedbackIngressModule],
  controllers: [WasenderWebhookController],
  providers: [
    WasenderWebhookParser,
    {
      provide: WasenderWebhookSignatureVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => {
        const secret = config.get("WASENDER_WEBHOOK_SECRET", { infer: true });

        if (!secret) {
          throw new Error(
            "WASENDER_WEBHOOK_SECRET is required when the Wasender webhook is enabled",
          );
        }

        return new WasenderWebhookSignatureVerifier(secret);
      },
    },
  ],
  exports: [WasenderWebhookParser],
})
export class WasenderHttpModule {}
