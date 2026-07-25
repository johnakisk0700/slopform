import { Module } from "@nestjs/common";

import { MongoModule } from "../../infrastructure/mongo/mongo.module.js";
import { ConversationThreadRepository } from "./conversation-thread.repository.js";
import { FeedbackConversationRepository } from "./feedback-conversation.repository.js";

@Module({
  imports: [MongoModule],
  providers: [ConversationThreadRepository, FeedbackConversationRepository],
  exports: [ConversationThreadRepository, FeedbackConversationRepository],
})
export class ConversationThreadModule {}
