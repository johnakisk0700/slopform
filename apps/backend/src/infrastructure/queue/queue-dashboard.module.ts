import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../config/environment.js";
import { createBullBoardAuthMiddleware } from "./bull-board-auth.middleware.js";
import {
  ASSISTANT_QUEUE,
  EMAIL_QUEUE,
  FEEDBACK_INGRESS_QUEUE,
  FEEDBACK_QUEUE,
  REFERENCE_QUEUE,
} from "./queue.constants.js";
import { QueueModule } from "./queue.module.js";

@Module({
  imports: [
    QueueModule,
    BullBoardModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        route: "/admin/queues",
        adapter: ExpressAdapter,
        middleware: createBullBoardAuthMiddleware({
          username: config.getOrThrow("BULL_BOARD_USERNAME", { infer: true }),
          password: config.getOrThrow("BULL_BOARD_PASSWORD", { infer: true }),
        }),
        boardOptions: {
          uiConfig: {
            boardTitle: "Join The Six queues",
            hideRedisDetails: true,
          },
        },
      }),
    }),
    BullBoardModule.forFeature({
      name: ASSISTANT_QUEUE,
      adapter: BullMQAdapter,
      options: {
        description: "Assistant response generation",
        readOnlyMode: true,
      },
    }),
    BullBoardModule.forFeature({
      name: EMAIL_QUEUE,
      adapter: BullMQAdapter,
      options: {
        description: "Provider-agnostic email outbox delivery",
        readOnlyMode: true,
      },
    }),
    BullBoardModule.forFeature({
      name: FEEDBACK_QUEUE,
      adapter: BullMQAdapter,
      options: {
        description: "Post-event feedback extraction, relay and sweeps",
        readOnlyMode: true,
      },
    }),
    BullBoardModule.forFeature({
      name: FEEDBACK_INGRESS_QUEUE,
      adapter: BullMQAdapter,
      options: {
        // Separate from the queue above so a backlog here is legible on sight:
        // anything waiting means inbound messages are not in the transcript yet.
        description: "Post-event feedback ingress materialization",
        readOnlyMode: true,
      },
    }),
    BullBoardModule.forFeature({
      name: REFERENCE_QUEUE,
      adapter: BullMQAdapter,
      options: {
        description: "Disposable golden-module jobs",
        readOnlyMode: true,
      },
    }),
  ],
})
export class QueueDashboardModule {}
