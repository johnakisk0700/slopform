import { Module } from "@nestjs/common";

import { OverviewController } from "./overview.controller.js";
import { OverviewModule } from "./overview.module.js";

@Module({
  imports: [OverviewModule],
  controllers: [OverviewController],
})
export class OverviewHttpModule {}
