import { Injectable } from "@nestjs/common";

import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { FeedbackAiTurnAnalysis } from "./ai-turn-analysis.service.js";
import { FeedbackConversationExecutionGuardError } from "./execution-guard.js";
import type {
  ExtractPlannedTurn,
  ExtractRunSnapshot,
} from "./extract.types.js";
import { FeedbackModelContextBuilder } from "./model-context.service.js";
import { FeedbackParticipantReplyPlanner } from "./participant-reply.service.js";
import { extractionTurnLogContext } from "./turn-planning.types.js";

/**
 * One planned extraction turn: prepare context, analyze model output, then
 * plan the participant reply. Persistence is not here.
 */
@Injectable()
export class FeedbackExtractionTurnService {
  private readonly logger = new FeedbackLogger(
    FeedbackExtractionTurnService.name,
  );

  constructor(
    private readonly modelContext: FeedbackModelContextBuilder,
    private readonly aiTurn: FeedbackAiTurnAnalysis,
    private readonly participantReply: FeedbackParticipantReplyPlanner,
  ) {}

  async plan(snapshot: ExtractRunSnapshot): Promise<ExtractPlannedTurn> {
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "extract_plan",
      ...extractionTurnLogContext(snapshot),
    });
    try {
      operation.stage("prepare_context");
      // Assemble the testimony and live facts the AI is allowed to see.
      const prepared = await this.modelContext.prepare(snapshot);
      operation.stage("generate_and_validate");
      // Extract feedback and classify attention; reject unsupported model claims.
      const analyzed = await this.aiTurn.analyze(snapshot, prepared);
      operation.stage("resolve_reply");
      // Choose the reply, apply policy answers, and withhold it if state changed.
      const planned = await this.participantReply.plan(
        snapshot,
        prepared,
        analyzed,
      );
      operation.complete("planned");
      return planned;
    } catch (error) {
      if (
        error instanceof FeedbackConversationExecutionGuardError &&
        error.reason === "authoritative_state_changed"
      ) {
        operation.failed(error, "superseded");
      } else {
        operation.failed(error);
      }
      throw error;
    }
  }
}
