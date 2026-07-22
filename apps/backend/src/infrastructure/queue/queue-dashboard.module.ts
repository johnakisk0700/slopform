import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { Module } from "@nestjs/common";

import { protectBullBoard } from "./bull-board-auth.middleware.js";
import { REFERENCE_QUEUE } from "./queue.constants.js";
import { QueueModule } from "./queue.module.js";

@Module({
  imports: [
    QueueModule,
    BullBoardModule.forRoot({
      route: "/admin/queues",
      adapter: ExpressAdapter,
      middleware: protectBullBoard,
      boardOptions: {
        uiConfig: {
          boardTitle: "Join The Six queues",
          hideRedisDetails: true,
        },
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
