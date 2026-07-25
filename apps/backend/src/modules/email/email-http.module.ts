import { Module } from "@nestjs/common";

import { EmailController } from "./email.controller.js";
import { EmailCoreModule } from "./email-core.module.js";

@Module({
  imports: [EmailCoreModule],
  controllers: [EmailController],
})
export class EmailHttpModule {}
