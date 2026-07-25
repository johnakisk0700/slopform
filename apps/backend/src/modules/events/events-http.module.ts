import { Module } from "@nestjs/common";

import { EventsController } from "./events.controller.js";
import { EventsCoreModule } from "./events-core.module.js";

@Module({
  imports: [EventsCoreModule],
  controllers: [EventsController],
})
export class EventsHttpModule {}
