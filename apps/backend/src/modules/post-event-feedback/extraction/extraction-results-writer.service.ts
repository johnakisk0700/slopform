import { Injectable } from "@nestjs/common";
import type {
  FeedbackExtractionResultsWriteInput,
  FeedbackExtractionResultsWriteCounts,
} from "./extraction-commit.types.js";
import type {
  AppTransaction,
  FeedbackExtractionMeta,
} from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import {
  contradictedPostEventFeedbackQuestionKeys,
  noteSignature,
} from "../question-set.js";
import {
  isSafetyOrHandoffAttention,
  respondentSourceMessageIds,
} from "./operator-attention.js";
import { FeedbackResultsRepository } from "./results.repository.js";

/**
 * Paid answers, contradicted-answer cleanup, note dedupe, extraction
 * metadata, and safety/handoff audit on the caller's transaction.
 * Starts no transaction and does not decide reply eligibility.
 */
@Injectable()
export class FeedbackExtractionResultsWriter {
  constructor(
    private readonly results: FeedbackResultsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async write(
    transaction: AppTransaction,
    input: FeedbackExtractionResultsWriteInput,
  ): Promise<FeedbackExtractionResultsWriteCounts> {
    const candidateIds = input.context.candidates.map(
      (candidate) => candidate.participantId,
    );
    const heldMessageIds = respondentSourceMessageIds(
      input.validated.safetySignals,
    );

    let answersWritten = 0;
    for (const answer of input.validated.answers) {
      if (answer.subjectParticipantId) {
        await this.results.deleteContradictedAnswers(transaction, {
          conversationId: input.conversation._id,
          subjectParticipantId: answer.subjectParticipantId,
          questionKeys: contradictedPostEventFeedbackQuestionKeys(
            answer.questionKey,
            input.context.goals.map((goal) => goal.key),
          ),
        });
      }
      const inserted = await this.results.insertAnswerIfAbsent(transaction, {
        campaignId: input.campaign.id,
        conversationId: input.conversation._id,
        respondentParticipantId: input.conversation.respondentParticipantId,
        subjectParticipantId: answer.subjectParticipantId,
        questionKey: answer.questionKey,
        valueInt: answer.valueInt,
        sourceMessageIds: answer.sourceMessageIds,
        extractionMeta: buildExtractionMeta({
          model: input.model,
          confidence: answer.confidence,
          candidateIds,
        }),
        matchingHold: answer.sourceMessageIds.some((messageId) =>
          heldMessageIds.has(messageId),
        ),
      });
      if (inserted) {
        answersWritten += 1;
      }
    }

    const storedNotes = await this.results.listNotesByConversation(
      input.conversation._id,
      transaction,
    );
    const storedNoteKeys = new Set(
      storedNotes.map((note) =>
        noteSignature(
          note.noteType,
          note.text,
          note.subjectParticipantId ?? null,
        ),
      ),
    );

    let notesWritten = 0;
    for (const note of input.validated.notes) {
      const signature = noteSignature(
        note.noteType,
        note.text,
        note.subjectParticipantId,
      );
      if (storedNoteKeys.has(signature)) {
        continue;
      }
      storedNoteKeys.add(signature);
      await this.results.insertNote(transaction, {
        campaignId: input.campaign.id,
        conversationId: input.conversation._id,
        respondentParticipantId: input.conversation.respondentParticipantId,
        subjectParticipantId: note.subjectParticipantId,
        noteType: note.noteType,
        text: note.text,
        sourceMessageIds: note.sourceMessageIds,
        extractionMeta: buildExtractionMeta({
          model: input.model,
          confidence: note.confidence,
          candidateIds,
          flaggedForReview: note.flaggedForReview,
          unresolvedSubjectName: note.unresolvedSubjectName,
        }),
      });
      notesWritten += 1;
    }

    if (isSafetyOrHandoffAttention(input.validated)) {
      await this.audit.append(transaction, {
        actorType: "system",
        actorId: "feedback_extraction",
        action:
          input.validated.safetySignals.length > 0
            ? "feedback_conversation.safety_signalled"
            : "feedback_conversation.handoff_requested",
        entityType: "feedback_conversation",
        entityId: input.conversation._id,
        requestId: input.correlationId,
        context: {
          campaignId: input.conversation.campaignId,
          model: input.model,
          confidence: input.validated.confidence,
          safetySignal: input.validated.safetySignals.length > 0,
          safetySignals: input.validated.safetySignals.map((signal) => ({
            category: signal.category,
            recommendedAction: signal.recommendedAction,
            sourceMessageIds: [...signal.sourceMessageIds],
            confidence: signal.confidence,
          })),
          handoff: input.validated.handoff,
        },
      });
    }

    return { answersWritten, notesWritten };
  }
}

function buildExtractionMeta(input: {
  readonly model: string;
  readonly confidence: number;
  readonly candidateIds: readonly string[];
  readonly flaggedForReview?: boolean;
  readonly unresolvedSubjectName?: string | null;
}): FeedbackExtractionMeta {
  return {
    model: input.model,
    confidence: input.confidence,
    candidateIds: [...input.candidateIds],
    ...(input.flaggedForReview ? { flaggedForReview: true } : {}),
    ...(input.unresolvedSubjectName
      ? { unresolvedSubjectName: input.unresolvedSubjectName }
      : {}),
  };
}
