import { Module } from "@nestjs/common";

import { ParticipantsController } from "./participants.controller.js";
import { ParticipantsCoreModule } from "./participants-core.module.js";

@Module({
  imports: [ParticipantsCoreModule],
  controllers: [ParticipantsController],
})
export class ParticipantsHttpModule {}
