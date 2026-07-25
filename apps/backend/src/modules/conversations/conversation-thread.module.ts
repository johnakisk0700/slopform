import { Module } from "@nestjs/common";

import { MongoModule } from "../../infrastructure/mongo/mongo.module.js";
import { ConversationThreadRepository } from "./conversation-thread.repository.js";

@Module({
  imports: [MongoModule],
  providers: [ConversationThreadRepository],
  exports: [ConversationThreadRepository],
})
export class ConversationThreadModule {}
