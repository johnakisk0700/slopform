import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@slopform/database";

function leadingInput<T>(transactionOrInput: unknown, maybeInput?: T): T {
  return (maybeInput ?? transactionOrInput) as T;
}
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AuditRepository } from "../../../apps/backend/src/infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../../apps/backend/src/infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.repository.js";
import type { EventsService } from "../../../apps/backend/src/modules/events/events.service.js";
import type { EventFeedbackVenueSnapshot } from "../../../apps/backend/src/modules/events/event-venue.js";
import type { ParticipantsRepository } from "../../../apps/backend/src/modules/participants/participants.repository.js";
import type { FeedbackOperatorAlertInput } from "../../../apps/backend/src/modules/post-event-feedback/operator-alert.js";
import type { FeedbackOutboundLogRepository } from "../../../apps/backend/src/modules/post-event-feedback/outbox/outbound-log.repository.js";
import { FeedbackOutboundIntentService } from "../../../apps/backend/src/modules/post-event-feedback/outbox/outbound-intent.service.js";
import { FeedbackOutboundTranscriptService } from "../../../apps/backend/src/modules/post-event-feedback/outbox/outbound-transcript.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeFeedbackConversations,
  FakeParticipants,
  feedbackConversationFixture,
  feedbackStoredMessage,
} from "../post-event-feedback-doubles.harness.js";
import type { FeedbackOutboundDecision } from "../../../apps/backend/src/modules/post-event-feedback/outbox/outbound-log.schemas.js";
import type { OutboundConversationSnapshot } from "../../../apps/backend/src/modules/post-event-feedback/outbox/outbound-log.snapshot.js";
import {
  FEEDBACK_ANSWER_CORRECTIONS_KEY,
  isCorrectedAnswer,
} from "../../../apps/backend/src/modules/post-event-feedback/extraction/answer-corrections.js";
import { FEEDBACK_OPERATION_EVENT } from "../../../apps/backend/src/modules/post-event-feedback/feedback-operation-log.js";
import {
  FeedbackConversationExecutionGuardError,
  PostEventFeedbackExtractor,
} from "../../../apps/backend/src/modules/post-event-feedback/extraction/extract.service.js";
import { FeedbackExtractionAdmissionService } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-admission.service.js";
import { FeedbackModelContextBuilder } from "../../../apps/backend/src/modules/post-event-feedback/extraction/model-context.service.js";
import { FeedbackAiTurnAnalysis } from "../../../apps/backend/src/modules/post-event-feedback/extraction/ai-turn-analysis.service.js";
import { FeedbackParticipantReplyPlanner } from "../../../apps/backend/src/modules/post-event-feedback/extraction/participant-reply.service.js";
import { FeedbackExtractionResultsWriter } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-results-writer.service.js";
import { FeedbackExtractionStateApplier } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-state.service.js";
import { FeedbackExtractionCapacityService } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-capacity.service.js";
import { FeedbackExtractionGuards } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-guards.service.js";
import { FeedbackExtractionTurnService } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-turn.service.js";
import { FeedbackExtractionCommitService } from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction-commit.service.js";
import { FeedbackConversationCapacityError } from "../../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.repository.js";
import type { FeedbackConversationExecutionClaim } from "../../../apps/backend/src/modules/post-event-feedback/extraction/execution-fence.repository.js";
import {
  FeedbackExtractionGenerationError,
  type PostEventFeedbackExtractionModel,
} from "../../../apps/backend/src/integrations/llm/feedback-extraction-model.service.js";
import { PostEventFeedbackMetrics } from "../../../apps/backend/src/modules/post-event-feedback/metrics.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "../../../apps/backend/src/modules/post-event-feedback/question-set.js";
import type { FeedbackAnswerQuestionKey } from "@slopform/database";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  POST_EVENT_FEEDBACK_SAFETY_ASSURANCE,
  feedbackExtractionGoalVerdicts,
  type FeedbackExtractionAnswerProposal,
} from "../../../apps/backend/src/modules/post-event-feedback/extraction/extraction.schemas.js";
import { POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS } from "../../../apps/backend/src/modules/post-event-feedback/extraction/policy-answers.js";
import type { FeedbackCampaignRepository } from "../../../apps/backend/src/modules/post-event-feedback/campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "../../../apps/backend/src/modules/post-event-feedback/extraction/results.repository.js";
import type { FeedbackOutboxRepository } from "../../../apps/backend/src/modules/post-event-feedback/outbox/outbox.repository.js";
import type { FeedbackIngressRepository } from "../../../apps/backend/src/modules/post-event-feedback/ingress/ingress.repository.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const eventId = "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10";
const respondentId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const b1 = "00000000-0000-4000-8000-0000000000b1";
const b2 = "00000000-0000-4000-8000-0000000000b2";
const p1 = "00000000-0000-4000-8000-000000000001";
const p2 = "00000000-0000-4000-8000-000000000002";
const p3 = "00000000-0000-4000-8000-000000000003";
const nikos = "1b0a2f1c-2d3e-4f50-8a91-0b2c3d4e5f60";
const eleni = "2c1b3a2d-3e4f-5061-9b02-1c3d4e5f6071";
const kostas = "3d2c4b3e-4f50-6172-ac13-2d4e5f607182";
const correlationId = "correlation-1";
const model = "google/gemini-3.6-flash";

/**
 * What a handoff run leaves behind for the person it is promising.
 *
 * Prompt rules 9 and 10 ask for exactly this — a run does not swallow a note
 * because it is also asking for a human — and validation now refuses a handoff
 * that recorded nothing at all over testimony that still held an answer. The
 * fixture testimony below is «5! Ο Νίκος ήταν φοβερός», so every handoff case
 * here has to be as complete as the proposal it stands in for; without the note
 * these cases would be asserting the behaviour of a run that fails.
 */
const handoffNote = {
  noteType: "general",
  text: "Ζήτησε να μιλήσει με άνθρωπο της ομάδας.",
  subjectParticipantId: null,
  subjectMentionedName: null,
  sourceMessageIds: [p1],
  confidence: 0.9,
} as const;

describe("PostEventFeedbackExtractor", () => {
  let harness: Harness;

  function extractConversation() {
    const work = harness.conversations.get(conversationId).work;
    if (!work) throw new Error("Test conversation requires work state");
    harness.conversations.setExecutionFence(
      conversationId,
      work.executionEpoch,
    );
    return harness.extractor.extract({
      conversationId,
      correlationId,
      executionClaim: {
        conversationId,
        workRevision: work.revision,
        epoch: work.executionEpoch,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
  }

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    harness = createHarness();
    harness.conversations.setExecutionFence(conversationId, 3);
  });

  describe("cheap exits", () => {
    it("skips a closed conversation without calling the model", async () => {
      harness.conversations.get(conversationId).lifecycle = {
        state: "closed",
        reason: "stopped",
        closedAt: new Date(),
      };

      const result = await extractConversation();

      expect(result.outcome).toBe("skipped_closed");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("skips a conversation under human control", async () => {
      harness.conversations.get(conversationId).control = {
        mode: "human",
        source: "staff_action",
        changedAt: new Date(),
      };

      const result = await extractConversation();

      expect(result.outcome).toBe("skipped_human_control");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("skips when the cursor already covers the transcript", async () => {
      harness.conversations.get(conversationId).extraction.cursorSeq = 2;

      const result = await extractConversation();

      expect(result.outcome).toBe("skipped_cursor");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("advances the cursor without a model call when only the bot spoke", async () => {
      const conversation = harness.conversations.get(conversationId);
      harness.conversations.replaceMessages(conversationId, [
        feedbackStoredMessage({
          id: b1,
          seq: 1,
          actor: "bot",
          text: "Καλησπέρα!",
          at: new Date(),
        }),
      ]);
      conversation.extraction.cursorSeq = 0;

      const result = await extractConversation();

      expect(result.outcome).toBe("skipped_no_new_testimony");
      expect(harness.generation.propose).not.toHaveBeenCalled();
      expect(conversation.extraction.cursorSeq).toBe(1);
    });
  });

  describe("the extraction run", () => {
    it("revalidates the fenced claim inside every granted provider slot", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      harness.executionFence.isCurrent.mockResolvedValue(false);
      harness.generation.propose.mockImplementation(
        async (
          _prompt: unknown,
          _questionKeys: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return generation({});
        },
      );
      harness.generation.classifyAttention.mockImplementation(
        async (
          _messages: unknown,
          _targetIds: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return attentionGeneration([]);
        },
      );

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).rejects.toMatchObject({
        name: FeedbackConversationExecutionGuardError.name,
        reason: "execution_claim_lost",
      });

      expect(harness.executionFence.isCurrent).toHaveBeenCalledWith(
        expect.anything(),
        executionClaim,
      );
      expect(harness.repository.answers).toHaveLength(0);
      expect(harness.repository.notes).toHaveLength(0);
      expect(harness.repository.outbox).toHaveLength(0);
    });

    it("does not buy a model call when a newer fragment advances the conversation work revision while waiting", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      harness.conversations.get(conversationId).work = {
        revision: 8,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.generation.propose.mockImplementation(
        async (
          _prompt: unknown,
          _questionKeys: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return generation({});
        },
      );
      harness.generation.classifyAttention.mockImplementation(
        async (
          _messages: unknown,
          _targetIds: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return attentionGeneration([]);
        },
      );

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).rejects.toMatchObject({
        name: FeedbackConversationExecutionGuardError.name,
        reason: "authoritative_state_changed",
      });

      expect(harness.executionFence.isCurrent).toHaveBeenCalledWith(
        expect.anything(),
        executionClaim,
      );
      expect(harness.repository.answers).toHaveLength(0);
      expect(harness.repository.notes).toHaveLength(0);
      expect(harness.repository.outbox).toHaveLength(0);
    });

    it("keeps paid results but lets takeover-resume successor work suppress the old reply and cursor", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      const live = harness.conversations.get(conversationId);
      live.work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.executionFence.renewWithin.mockResolvedValue(executionClaim);
      harness.generation.propose.mockImplementation(
        async (
          _prompt: unknown,
          _questionKeys: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return generation({
            answers: [
              {
                questionKey: "event_score",
                valueInt: 5,
                subjectParticipantId: null,
                subjectMentionedName: null,
                sourceMessageIds: [p1],
                confidence: 0.95,
              },
            ],
            nextGoal: "liked",
          });
        },
      );
      harness.generation.classifyAttention.mockImplementation(
        async (
          _messages: unknown,
          _targetIds: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          // The person took over and handed control back while this paid call
          // was running. `mode=bot` is the same value as the snapshot; the
          // monotonic work/control generation is what makes the ABA visible.
          live.control = {
            mode: "bot",
            source: "staff_action",
            changedAt: new Date("2026-07-25T10:03:00.000Z"),
          };
          live.work = {
            revision: 8,
            nextActionAt: new Date("2026-07-25T10:03:00.000Z"),
            executionEpoch: 3,
          };
          return attentionGeneration([]);
        },
      );

      await harness.extractor.extract({
        conversationId,
        correlationId,
        executionClaim,
      });

      // The provider was already paid, so the valid answer remains useful.
      expect(harness.repository.answers).toEqual([
        expect.objectContaining({ questionKey: "event_score", valueInt: 5 }),
      ]);
      // But the old generation owns neither participant-facing copy nor the
      // cursor that keeps the successor revision discoverable.
      expect(harness.repository.outbox).toHaveLength(0);
      expect(live.messages).toHaveLength(2);
      expect(live.extraction.cursorSeq).toBe(0);
      expect(live.work).toMatchObject({ revision: 8, executionEpoch: 3 });
    });

    it("keeps paid facts but withholds copy when successor work arrives before the optional reply rewrite", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      const live = harness.conversations.get(conversationId);
      live.work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.executionFence.renewWithin.mockResolvedValue(executionClaim);
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 5,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.95,
            },
          ],
          nextGoal: "liked",
          reply: "Ποιος σου έκανε εντύπωση;",
        }),
      );
      harness.generation.rewriteReply.mockImplementation(
        async (
          _prompt: unknown,
          _draft: string,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          live.work = {
            revision: 8,
            nextActionAt: new Date(),
            executionEpoch: 3,
          };
          await beforeProviderCall?.();
          throw new Error("provider guard should have rejected the rewrite");
        },
      );

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).resolves.toMatchObject({ outcome: "extracted", cursorSeq: 2 });

      expect(harness.repository.answers).toEqual([
        expect.objectContaining({ questionKey: "event_score", valueInt: 5 }),
      ]);
      expect(harness.repository.outbox).toHaveLength(0);
      expect(live.messages).toHaveLength(2);
      expect(live.extraction.cursorSeq).toBe(0);
      expect(live.work).toMatchObject({ revision: 8, executionEpoch: 3 });
    });

    it("quarantines a missing execution projection as an invariant failure", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      harness.conversations.get(conversationId).work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.generation.propose.mockImplementation(
        async (
          _prompt: unknown,
          _questionKeys: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          harness.conversations.documents.delete(conversationId);
          await beforeProviderCall?.();
          return generation({});
        },
      );

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).rejects.toMatchObject({
        name: FeedbackConversationExecutionGuardError.name,
        reason: "execution_invariant_broken",
      });
      expect(harness.repository.answers).toHaveLength(0);
      expect(harness.repository.outbox).toHaveLength(0);
    });

    it("fences every provider entry in the stable lock order", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      harness.conversations.get(conversationId).work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.executionFence.renewWithin.mockResolvedValue(executionClaim);
      const phoneLock = vi.spyOn(harness.repository, "lockInboundPhone");
      const conversationLock = vi.spyOn(harness.repository, "lockConversation");
      const campaignLock = vi.spyOn(
        harness.repository,
        "findCampaignByIdForShare",
      );
      const participantLock = vi.spyOn(
        harness.participants,
        "findByIdForUpdate",
      );
      const inboundCheck = vi.spyOn(
        harness.repository,
        "hasInboundBeyondSnapshot",
      );
      const conversationRead = vi.spyOn(harness.conversations, "findById");
      harness.generation.propose.mockImplementation(
        async (
          _prompt: unknown,
          _questionKeys: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return generation({});
        },
      );
      harness.generation.classifyAttention.mockImplementation(
        async (
          _messages: unknown,
          _targetIds: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          return attentionGeneration([]);
        },
      );

      await harness.extractor.extract({
        conversationId,
        correlationId,
        executionClaim,
      });

      const first = (mock: { invocationCallOrder: number[] }) =>
        mock.invocationCallOrder[0] as number;
      expect(first(phoneLock.mock)).toBeLessThan(first(conversationLock.mock));
      expect(first(conversationLock.mock)).toBeLessThan(
        first(harness.executionFence.isCurrent.mock),
      );
      expect(first(harness.executionFence.isCurrent.mock)).toBeLessThan(
        first(campaignLock.mock),
      );
      expect(first(campaignLock.mock)).toBeLessThan(
        first(participantLock.mock),
      );
      expect(first(participantLock.mock)).toBeLessThan(
        first(inboundCheck.mock),
      );
      expect(first(inboundCheck.mock)).toBeLessThan(
        conversationRead.mock.invocationCallOrder[1] as number,
      );
    });

    it("does not enter the provider when unmaterialized ingress is ahead of the transcript", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      harness.conversations.get(conversationId).work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.repository.newerInboundBeyondSnapshot = true;
      let providerEntries = 0;
      harness.generation.propose.mockImplementation(
        async (
          _prompt: unknown,
          _questionKeys: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          providerEntries += 1;
          return generation({});
        },
      );
      harness.generation.classifyAttention.mockImplementation(
        async (
          _messages: unknown,
          _targetIds: unknown,
          beforeProviderCall?: () => Promise<void>,
        ) => {
          await beforeProviderCall?.();
          providerEntries += 1;
          return attentionGeneration([]);
        },
      );

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).rejects.toMatchObject({
        name: FeedbackConversationExecutionGuardError.name,
        reason: "authoritative_state_changed",
      });

      expect(providerEntries).toBe(0);
      expect(harness.repository.inboundPhoneLocks).not.toEqual([]);
      expect(harness.executionFence.renewWithin).not.toHaveBeenCalled();
    });

    it("persists answers and notes with the run's model, confidence and candidate ids", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 5,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.95,
            },
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: [p1],
              confidence: 0.8,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Η βραδιά κύλησε γρήγορα.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.6,
            },
          ],
          nextGoal: "meet_again",
          reply: "Ευχαριστούμε! Με ποιους θα ήθελες να ξαναβρεθείς;",
        }),
      );

      const result = await extractConversation();

      expect(result).toMatchObject({
        outcome: "extracted",
        answersWritten: 2,
        notesWritten: 1,
        cursorSeq: 2,
        model,
      });
      // D12: the candidate set of *this* run is what makes live selection
      // auditable later.
      expect(harness.repository.answers[0]?.extractionMeta).toEqual({
        model,
        confidence: 0.95,
        candidateIds: [nikos, eleni],
      });
      expect(harness.repository.notes[0]?.extractionMeta).toEqual({
        model,
        confidence: 0.6,
        candidateIds: [nikos, eleni],
      });
    });

    it("persists both phases' tokens together, and the tier that bought them", async () => {
      harness.generation.serviceTier = "priority";

      await extractConversation();

      // The proposal call and the attention call are one run and one bill.
      // 800 + 180 in, 110 + 40 out, 910 + 220 total.
      const { extraction } = harness.conversations.get(conversationId);
      expect(extraction.usage).toEqual({
        inputTokens: 980,
        outputTokens: 150,
        totalTokens: 1_130,
      });
      // Durable where `recordExtractTokens` is not: a restart takes the log
      // with it, and a paid rehearsal is costed off this document hours later.
      expect(extraction.serviceTier).toBe("priority");
    });

    it("forwards only the low-effort rewrite of a model-written reply", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Πώς σου φάνηκε συνολικά η βραδιά;",
        }),
      );
      harness.generation.rewriteReply.mockResolvedValue({
        model,
        reply: "Για πες, τι βαθμό θα έβαζες στη βραδιά από 1 ως 5;",
        usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120 },
        estimatedPromptTokens: 100,
      });

      await extractConversation();

      expect(harness.generation.rewriteReply).toHaveBeenCalledOnce();
      expect(harness.repository.outbox).toHaveLength(1);
      expect(harness.repository.outbox[0]).toMatchObject({
        body: "Για πες, τι βαθμό θα έβαζες στη βραδιά από 1 ως 5;",
      });
    });

    it("says nothing when the participant-facing rewrite fails", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Πώς σου φάνηκε συνολικά η βραδιά;",
        }),
      );
      harness.generation.rewriteReply.mockResolvedValue({
        model,
        reply: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        estimatedPromptTokens: 100,
      });

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      expect(harness.repository.outbox).toHaveLength(0);
      expect(
        harness.conversations.get(conversationId).extraction.cursorSeq,
      ).toBe(2);
    });

    it("adds the next run's tokens to what the conversation already spent", async () => {
      await extractConversation();

      const conversation = harness.conversations.get(conversationId);
      harness.conversations.pushStored(conversationId, {
        id: p2,
        seq: conversation.messages.length + 1,
        actor: "participant",
        text: "Α, και το φαγητό ήταν πολύ καλό.",
        at: new Date("2026-07-25T10:06:00.000Z"),
      });

      await extractConversation();

      expect(harness.generation.propose).toHaveBeenCalledTimes(2);
      expect(conversation.extraction.usage).toEqual({
        inputTokens: 1_960,
        outputTokens: 300,
        totalTokens: 2_260,
      });
    });

    it("poisons the total when either phase reports no tokens at all", async () => {
      // The rehearsal stub reports nulls, and so does a provider that answered
      // without a usage block. Either way the run's tokens went uncounted.
      harness.generation.classifyAttention.mockResolvedValue({
        ...attentionGeneration([]),
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      });

      await extractConversation();

      // Not 800/110/910. The extraction phase's numbers are real, but they are
      // not this run's cost, and a total that presents them as one is wrong in
      // the direction that flatters us.
      expect(
        harness.conversations.get(conversationId).extraction.usage,
      ).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    });

    it("never bills a run that advanced the cursor without calling the model", async () => {
      await extractConversation();
      const conversation = harness.conversations.get(conversationId);
      const afterFirstRun = { ...conversation.extraction.usage };

      // Only the bot spoke since. The cursor still moves — those messages are
      // read and settled — but no provider was reached, so nothing was bought.
      harness.conversations.pushStored(conversationId, {
        id: b2,
        seq: conversation.messages.length + 1,
        actor: "bot",
        text: "Ευχαριστούμε!",
        at: new Date("2026-07-25T10:07:00.000Z"),
      });

      const replay = await extractConversation();

      expect(replay.outcome).toBe("skipped_no_new_testimony");
      expect(harness.generation.propose).toHaveBeenCalledTimes(1);
      expect(conversation.extraction.usage).toEqual(afterFirstRun);
    });

    it("selects candidates live for every run rather than from the document", async () => {
      await extractConversation();

      expect(
        harness.events.listFeedbackCandidatesForRespondent,
      ).toHaveBeenCalledWith(eventId, respondentId);
    });

    it("hides provably unsent audit-intent turns from both model prompts without moving the raw cursor", async () => {
      const conversation = harness.conversations.get(conversationId);
      const at = new Date("2026-07-25T10:02:00.000Z");
      const outboxTurns = [
        ["pending", "FILTER_PENDING"],
        ["held", "FILTER_HELD"],
        ["claimed", "FILTER_CLAIMED"],
        ["failed", "FILTER_FAILED"],
        ["cancelled", "FILTER_CANCELLED"],
        ["attempting", "KEEP_ATTEMPTING"],
        ["ambiguous", "KEEP_AMBIGUOUS"],
        ["sending", "KEEP_LEGACY_SENDING"],
        ["sent", "KEEP_SENT"],
      ] as const;
      harness.conversations.replaceMessages(conversationId, [
        ...outboxTurns.map(([status, text], index) => {
          const outboxId = randomUUID();
          harness.repository.outbox.push({ id: outboxId, status });
          return feedbackStoredMessage({
            seq: index + 1,
            actor: "bot",
            text,
            at,
            outboxId,
          });
        }),
        feedbackStoredMessage({
          seq: 10,
          actor: "bot",
          text: "KEEP_MISSING_HISTORICAL_ROW",
          at,
        }),
        feedbackStoredMessage({
          seq: 11,
          actor: "participant",
          text: "KEEP_PARTICIPANT",
          at,
        }),
        feedbackStoredMessage({
          seq: 12,
          actor: "system",
          text: "KEEP_SYSTEM_WITHOUT_OUTBOX",
          at,
        }),
      ]);
      conversation.extraction.cursorSeq = 0;

      await extractConversation();

      const classifierMessages = harness.generation.classifyAttention.mock
        .calls[0]?.[0] as readonly { text: string }[];
      expect(classifierMessages.map(({ text }) => text)).toEqual([
        "KEEP_ATTEMPTING",
        "KEEP_AMBIGUOUS",
        "KEEP_LEGACY_SENDING",
        "KEEP_SENT",
        "KEEP_MISSING_HISTORICAL_ROW",
        "KEEP_PARTICIPANT",
        "KEEP_SYSTEM_WITHOUT_OUTBOX",
      ]);
      const prompt = harness.generation.propose.mock.calls[0]?.[0] as {
        readonly user: string;
      };
      for (const hidden of [
        "FILTER_PENDING",
        "FILTER_HELD",
        "FILTER_CLAIMED",
        "FILTER_FAILED",
        "FILTER_CANCELLED",
      ]) {
        expect(prompt.user).not.toContain(hidden);
      }
      for (const visible of classifierMessages) {
        expect(prompt.user).toContain(visible.text);
      }
      // Filtering is a provider-context projection only. The conversation row
      // remains the raw audit/UI transcript, and the cursor still settles its
      // full sequence.
      expect(conversation.messages).toHaveLength(12);
      expect(conversation.extraction.cursorSeq).toBe(12);
    });

    describe("venue context", () => {
      it("passes the enabled safe snapshot to the prompt and fences its revision", async () => {
        harness.events.getFeedbackVenueContext.mockResolvedValue({
          contextRevision: 7,
          venue: {
            label: "Nakama",
            type: "japanese restaurant",
            area: "Κέντρο Αθήνας",
            priceRange: {
              startMinor: 1_500,
              endMinor: 3_000,
              currencyCode: "EUR",
            },
          },
        } satisfies EventFeedbackVenueSnapshot);

        await extractConversation();

        const prompt = harness.generation.propose.mock.calls[0]?.[0] as
          { readonly user: string } | undefined;
        expect(prompt?.user).toContain(
          "ΠΛΑΙΣΙΟ ΧΩΡΟΥ (χειριστή· όχι μαρτυρία)",
        );
        expect(prompt?.user).toContain('- όνομα: "Nakama"');
        expect(prompt?.user).toContain('- τύπος: "japanese restaurant"');
        expect(prompt?.user).toContain('- περιοχή: "Κέντρο Αθήνας"');
        expect(prompt?.user).toContain("- κόστος ανά άτομο: 15–30 EUR");
        expect(
          harness.events.feedbackVenueContextIsCurrent,
        ).toHaveBeenCalledWith(expect.anything(), eventId, 7);
      });

      it.each([
        ["absent", 0],
        ["disabled", 11],
      ] as const)(
        "omits %s venue context and does not create a revision fence",
        async (_case, contextRevision) => {
          harness.events.getFeedbackVenueContext.mockResolvedValue({
            contextRevision,
            venue: null,
          } satisfies EventFeedbackVenueSnapshot);

          await extractConversation();

          const prompt = harness.generation.propose.mock.calls[0]?.[0] as
            { readonly user: string } | undefined;
          expect(prompt?.user).not.toContain("ΠΛΑΙΣΙΟ ΧΩΡΟΥ");
          expect(
            harness.events.feedbackVenueContextIsCurrent,
          ).not.toHaveBeenCalled();
        },
      );

      it("rejects a venue-dependent run before results, outbox or goal state when the revision changes", async () => {
        let currentVenueRevision = 7;
        harness.events.getFeedbackVenueContext.mockImplementation(
          async () =>
            ({
              contextRevision: currentVenueRevision,
              venue: {
                label: "Nakama",
                type: "japanese restaurant",
                area: "Κέντρο Αθήνας",
              },
            }) satisfies EventFeedbackVenueSnapshot,
        );
        harness.events.feedbackVenueContextIsCurrent.mockImplementation(
          async (
            _transaction: unknown,
            _eventId: string,
            expectedRevision: number,
          ) => expectedRevision === currentVenueRevision,
        );
        harness.generation.propose.mockImplementation(async () => {
          // Staff edits or disables the venue while the provider is thinking.
          currentVenueRevision += 1;
          return generation({
            answers: [
              {
                questionKey: "event_score",
                valueInt: 5,
                subjectParticipantId: null,
                subjectMentionedName: null,
                sourceMessageIds: [p1],
                confidence: 0.95,
              },
            ],
            nextGoal: "liked",
            reply: "Και ποιος σου έκανε ιδιαίτερα καλή εντύπωση;",
          });
        });
        harness.conversations.setAllGoals(conversationId, "pending");
        const goalsBefore = harness.conversations.goalStatuses(conversationId);

        const failure = await extractConversation().catch(
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(FeedbackExtractionGenerationError);
        expect(failure).toMatchObject({
          code: "extraction_failed",
          retryable: true,
          failureCause: "validation_failed",
        });
        expect(
          harness.events.feedbackVenueContextIsCurrent,
        ).toHaveBeenCalledWith(expect.anything(), eventId, 7);
        expect(harness.repository.locked).toBe(0);
        expect(harness.repository.answers).toEqual([]);
        expect(harness.repository.notes).toEqual([]);
        expect(harness.repository.outbox).toEqual([]);
        expect(harness.repository.outboxLogs).toEqual([]);
        expect(harness.conversations.goalStatuses(conversationId)).toEqual(
          goalsBefore,
        );
        expect(
          harness.conversations.get(conversationId).extraction.cursorSeq,
        ).toBe(0);
      });
    });

    it("records a degraded subject in the note meta instead of guessing", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          notes: [
            {
              noteType: "general",
              text: "Η Ρούλα ήταν πολύ γλυκιά.",
              subjectParticipantId: null,
              subjectMentionedName: "Ρούλα",
              sourceMessageIds: [p1],
              confidence: 0.6,
            },
          ],
        }),
      );

      await extractConversation();

      expect(harness.repository.notes[0]).toMatchObject({
        subjectParticipantId: null,
        extractionMeta: {
          model,
          confidence: 0.6,
          candidateIds: [nikos, eleni],
          flaggedForReview: true,
          unresolvedSubjectName: "Ρούλα",
        },
      });
      // D18 without a visible flag is a safeguard nobody ever learns fired.
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        true,
      );
      // Routine unresolvable names are inbox work, not a page.
      expect(harness.alert.raised).toEqual([]);
    });

    it("records a corrected score over the stored one and still raises attention", async () => {
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 4,
        noteType: null,
        text: null,
        extractionMeta: { model, confidence: 1, candidateIds: [] },
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 2,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Το άλλαξα σε 2!",
          nextGoal: "liked",
        }),
      );

      await extractConversation();

      // One row, holding what they last said. The attention flag stays because
      // a change of mind is worth a human's eye — it is no longer the only
      // trace that the answer was ever anything else.
      expect(harness.repository.answers).toHaveLength(1);
      expect(harness.repository.answers[0]).toMatchObject({ valueInt: 2 });
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        true,
      );
      expect(harness.alert.raised).toEqual([]);
    });

    it("enqueues exactly one reply keyed by conversation and cursor", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Ευχαριστούμε πολύ!",
        }),
      );

      await extractConversation();

      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          conversationId,
          campaignId,
          kind: "reply",
          body: "Ευχαριστούμε πολύ!",
          // Anchored on the participant's message (seq 2), not on the
          // transcript length, which this run's own reply changes.
          dedupeKey: `feedback-reply-${conversationId}-2`,
        }),
      ]);
      // The same reply is a bot turn in the transcript, so the admin pane and
      // the next extraction prompt both see what the bot said.
      expect(
        harness.conversations.get(conversationId).messages.at(-1),
      ).toMatchObject({
        actor: "bot",
        text: "Ευχαριστούμε πολύ!",
        outboxId: harness.repository.outbox[0]?.["id"],
      });
      const replyOutboxId = harness.repository.outbox[0]?.["id"];
      expect(
        harness.repository.outboxLogs.filter(
          (row) => row.outboxId === replyOutboxId,
        ),
      ).toHaveLength(1);
      expect(harness.repository.outboxLogs[0]).toMatchObject({
        outboxId: replyOutboxId,
        origin: "extraction_reply",
        decision: expect.objectContaining({
          origin: "extraction_reply",
          model,
        }),
        conversationState: expect.objectContaining({
          lifecycle: expect.objectContaining({ state: "open" }),
        }),
      });
    });

    it("transcribes the closing copy when the conversation completes", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.generation.propose.mockResolvedValue(generation({ reply: null }));

      const result = await extractConversation();

      expect(result.outcome).toBe("completed");
      const closing = harness.repository.outbox[0];
      expect(closing).toMatchObject({
        dedupeKey: `feedback-closing-${conversationId}-2-r0`,
      });
      expect(
        harness.conversations.get(conversationId).messages.at(-1),
      ).toMatchObject({
        actor: "bot",
        text: closing?.["body"],
        outboxId: closing?.["id"],
      });
    });

    it("marks the answered goal and the asked next goal", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
          reply: "Ποιος σου έκανε εντύπωση;",
        }),
      );

      await extractConversation();

      expect(harness.conversations.goalStatuses(conversationId)).toMatchObject({
        event_score: "answered",
        liked: "asked",
      });
    });

    it("re-asks the score when the model confirms an out-of-range value that was refused", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 10,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
          reply: "Τέλεια, χαίρομαι πολύ! 🙂",
        }),
      );

      await extractConversation();

      expect(harness.repository.answers).toEqual([]);
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.event_score,
        }),
      ]);
      // The confirming lie must not reach the phone, and the ladder must stay on
      // the refused score rather than advancing to the model's nextGoal.
      expect(harness.repository.outbox[0]?.["body"]).not.toContain("Τέλεια");
      expect(
        harness.conversations.goalStatuses(conversationId).event_score,
      ).toBe("asked");
    });

    it("asks the next open goal instead of sending a thank-you when directed answers were refused", async () => {
      harness.conversations.setGoal(conversationId, "event_score", "answered");
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 5,
        noteType: null,
        text: null,
        extractionMeta: { model, confidence: 1, candidateIds: [] },
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: null,
              subjectMentionedName: "Μαρη",
              sourceMessageIds: [p1],
              confidence: 0.8,
            },
            {
              questionKey: "meet_again",
              valueInt: null,
              subjectParticipantId: null,
              subjectMentionedName: "Μαρη",
              sourceMessageIds: [p1],
              confidence: 0.8,
            },
          ],
          skippedGoals: ["avoid"],
          nextGoal: null,
          reply: "Ευχαριστούμε για το feedback 🙂",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      expect(harness.conversations.get(conversationId).lifecycle.state).toBe(
        "open",
      );
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.liked,
        }),
      ]);
      expect(harness.repository.outbox[0]?.["body"]).not.toBe(
        POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.closing,
      );
    });

    it("does not buy a model call after opt-in was withdrawn", async () => {
      harness.participants.rows.set(respondentId, {
        id: respondentId,
        preferredName: null,
        emailNormalized: `${respondentId}@example.test`,
        phoneE164: null,
        postEventFeedbackWhatsappOptIn: false,
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Ευχαριστούμε!",
          nextGoal: "event_score",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("skipped_consent_withdrawn");
      expect(harness.generation.propose).not.toHaveBeenCalled();
      expect(harness.repository.answers).toHaveLength(0);
      expect(harness.repository.outbox).toHaveLength(0);
    });
  });

  describe("a burst that straddles the run", () => {
    /**
     * The participant types another fragment while the model is thinking. The
     * quiet window on the enqueue collapses everything typed before the run
     * opens; this is the remainder it cannot reach.
     */
    const typesDuringTheRun = (
      overrides: Record<string, unknown> = {
        nextGoal: "event_score",
        reply: "Ευχαριστούμε πολύ!",
      },
    ): void => {
      harness.generation.propose.mockImplementation(async () => {
        await harness.conversations.appendMessage({
          conversationId,
          actor: "participant",
          text: "α και κάτι ακόμα",
          at: new Date("2026-07-25T10:06:00.000Z"),
          ingressId: randomUUID(),
        });
        return generation(overrides);
      });
    };

    it("drops the ordinary reply, which now answers a thought that moved on", async () => {
      typesDuringTheRun();

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      // The run reading the newer message speaks instead: one reply per burst,
      // not one per fragment.
      expect(harness.repository.outbox).toEqual([]);
    });

    it("drops the ordinary reply when newer durable ingress has not reached the transcript yet", async () => {
      harness.repository.newerInboundBeyondSnapshot = true;
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 5,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
          reply: "Ευχαριστούμε πολύ!",
        }),
      );

      const result = await extractConversation();

      expect(result).toMatchObject({ answersWritten: 1, cursorSeq: 2 });
      expect(harness.repository.outbox).toEqual([]);
      expect(harness.repository.inboundPhoneLocks).toEqual(["+306900000001"]);
    });

    it("still writes its results and closes its own window", async () => {
      typesDuringTheRun({
        answers: [
          {
            questionKey: "event_score",
            valueInt: 5,
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ],
        nextGoal: "liked",
        reply: "Ευχαριστούμε πολύ!",
      });

      const result = await extractConversation();

      // Only the outbound is dropped. Suppressing the cursor instead would make
      // "I chose to wait" indistinguishable on disk from "I crashed", and a
      // retry could not tell which one to repair.
      expect(result).toMatchObject({ answersWritten: 1, cursorSeq: 2 });
      expect(harness.repository.answers).toHaveLength(1);
      expect(
        harness.conversations.get(conversationId).extraction.cursorSeq,
      ).toBe(2);
      expect(harness.repository.outbox).toEqual([]);
    });

    it("defers closing when newer testimony lands during the model call", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      typesDuringTheRun({ reply: null });

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      expect(harness.repository.outbox).toEqual([]);
      expect(harness.conversations.get(conversationId)).toMatchObject({
        lifecycle: { state: "open", reason: null },
        extraction: { cursorSeq: 2 },
      });
    });

    it("defers closing when durable ingress has not reached the transcript yet", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.repository.newerInboundBeyondSnapshot = true;
      harness.generation.propose.mockResolvedValue(generation({ reply: null }));

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      expect(harness.repository.outbox).toEqual([]);
      expect(harness.repository.inboundPhoneLocks).toEqual(["+306900000001"]);
      expect(harness.conversations.get(conversationId)).toMatchObject({
        lifecycle: { state: "open", reason: null },
        extraction: { cursorSeq: 2 },
      });
    });

    it("loses the terminal close when human takeover wins at the final boundary", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.generation.propose.mockResolvedValue(generation({ reply: null }));
      harness.conversations.beforeTerminalClose = () => {
        const conversation = harness.conversations.get(conversationId);
        conversation.control = {
          mode: "human",
          source: "staff_action",
          changedAt: new Date("2026-07-25T10:06:00.000Z"),
        };
      };

      const result = await extractConversation();

      expect(result).toMatchObject({ outcome: "extracted" });
      expect(result).not.toHaveProperty("outboxId");
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          status: "cancelled",
          lastError: "terminal_snapshot_superseded",
        }),
      ]);
      expect(harness.conversations.get(conversationId)).toMatchObject({
        lifecycle: { state: "open", reason: null },
        control: { mode: "human" },
        // Takeover superseded the terminal transition without leaving newer
        // testimony. Keeping the snapshot unread lets a later explicit resume
        // reconcile the close instead of drifting into reminder/expiry.
        extraction: { cursorSeq: 0 },
      });
    });

    it("mints a fresh terminal row when takeover and resume keep the same testimony", async () => {
      const firstClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      const resumedClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 8,
        epoch: 4,
        token: "22222222-2222-4222-8222-222222222222",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      const conversation = harness.conversations.get(conversationId);
      conversation.work = {
        revision: firstClaim.workRevision,
        nextActionAt: new Date(),
        executionEpoch: firstClaim.epoch,
      };
      harness.executionFence.renewWithin.mockResolvedValue(firstClaim);
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.generation.propose.mockResolvedValue(generation({ reply: null }));
      let takeoverPending = true;
      harness.conversations.beforeTerminalClose = () => {
        if (!takeoverPending) return;
        takeoverPending = false;
        conversation.control = {
          mode: "human",
          source: "staff_action",
          changedAt: new Date("2026-07-25T10:06:00.000Z"),
        };
      };

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim: firstClaim,
        }),
      ).resolves.toMatchObject({ outcome: "extracted" });

      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          dedupeKey: `feedback-closing-${conversationId}-2-r7`,
          status: "cancelled",
          lastError: "terminal_snapshot_superseded",
        }),
      ]);
      expect(conversation).toMatchObject({
        lifecycle: { state: "open", reason: null },
        control: { mode: "human" },
        extraction: { cursorSeq: 0 },
      });

      // `resumeBot` increments the durable revision, and the next reconciliation
      // admits a new execution epoch before extraction reloads the aggregate.
      conversation.control = {
        mode: "bot",
        source: "staff_action",
        changedAt: new Date("2026-07-25T10:07:00.000Z"),
      };
      conversation.work = {
        revision: resumedClaim.workRevision,
        nextActionAt: new Date(),
        executionEpoch: resumedClaim.epoch,
      };
      harness.conversations.setExecutionFence(
        conversationId,
        resumedClaim.epoch,
      );
      harness.executionFence.renewWithin.mockResolvedValue(resumedClaim);

      const resumed = await harness.extractor.extract({
        conversationId,
        correlationId: `${correlationId}-resumed`,
        executionClaim: resumedClaim,
      });

      expect(resumed).toMatchObject({ outcome: "completed" });
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          dedupeKey: `feedback-closing-${conversationId}-2-r7`,
          status: "cancelled",
        }),
        expect.objectContaining({
          id: resumed.outboxId,
          dedupeKey: `feedback-closing-${conversationId}-2-r8`,
          status: "pending",
        }),
      ]);
      expect(conversation.lifecycle).toMatchObject({
        state: "closed",
        reason: "completed",
        terminalOutboxId: resumed.outboxId,
      });
    });

    it("keeps terminal testimony unread when only a control generation supersedes the close", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      const conversation = harness.conversations.get(conversationId);
      conversation.work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.executionFence.renewWithin.mockResolvedValue(executionClaim);
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.generation.propose.mockResolvedValue(generation({ reply: null }));
      harness.conversations.beforeTerminalClose = () => {
        conversation.work = {
          revision: 8,
          nextActionAt: new Date(),
          executionEpoch: 3,
        };
      };

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).resolves.toMatchObject({ outcome: "extracted" });

      expect(conversation).toMatchObject({
        lifecycle: { state: "open", reason: null },
        extraction: { cursorSeq: 0 },
        work: { revision: 8, executionEpoch: 3 },
      });
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          status: "cancelled",
          lastError: "terminal_snapshot_superseded",
        }),
      ]);
    });

    it("still sends the handoff copy, because it promises a human", async () => {
      typesDuringTheRun({
        handoff: true,
        notes: [handoffNote],
        reply: "Ευχαριστούμε πολύ!",
      });

      const result = await extractConversation();

      expect(result.outcome).toBe("handoff");
      expect(harness.repository.outbox[0]).toMatchObject({
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
      });
    });
  });

  describe("completion", () => {
    it("anchors a model-authored empty-ladder goodbye to the terminal declined commitment", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          skippedGoals: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.map(
            (question) => question.key,
          ),
          reply: "Δίκαιο — το ερωτηματολόγιο μόλις έφαγε πόρτα 😅",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("declined");
      expect(harness.conversations.get(conversationId).lifecycle).toMatchObject(
        {
          state: "closed",
          reason: "declined",
          terminalOutboxId: result.outboxId,
        },
      );
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: "Δίκαιο — το ερωτηματολόγιο μόλις έφαγε πόρτα 😅",
          dedupeKey: `feedback-closing-${conversationId}-2-r0`,
        }),
      ]);
    });

    it("closes as completed and sends the campaign's closing copy once", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"], reply: "Ευχαριστούμε!" }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("completed");
      expect(harness.conversations.get(conversationId).lifecycle).toMatchObject(
        {
          state: "closed",
          reason: "completed",
        },
      );
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.closing,
          dedupeKey: `feedback-closing-${conversationId}-2-r0`,
        }),
      ]);
    });

    it("locks the terminal close and retracts every pre-send row except its winner", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      const staleId = randomUUID();
      harness.repository.outbox.push({
        id: staleId,
        conversationId,
        campaignId,
        kind: "reply",
        body: "Παλιότερη ερώτηση",
        dedupeKey: `feedback-reply-${conversationId}-1`,
        status: "claimed",
        claimExpiresAt: new Date(Date.now() + 60_000),
        sendStartedAt: null,
      });
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"], reply: "Ευχαριστούμε!" }),
      );
      harness.conversations.beforeTerminalClose = () => {
        // Persist already holds the conversation mutex; terminal close
        // re-takes it before advanceCursorAndClose.
        expect(harness.repository.locked).toBeGreaterThanOrEqual(2);
      };

      const result = await extractConversation();

      expect(result.outcome).toBe("completed");
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({ id: staleId, status: "cancelled" }),
        expect.objectContaining({
          id: result.outboxId,
          status: "pending",
          dedupeKey: `feedback-closing-${conversationId}-2-r0`,
        }),
      ]);
      expect(
        harness.conversations.get(conversationId).lifecycle.terminalOutboxId,
      ).toBe(result.outboxId);
    });

    it("cancels a pending fixed V1 closing row before inserting the anchored close", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      const legacyId = randomUUID();
      harness.repository.outbox.push({
        id: legacyId,
        conversationId,
        campaignId,
        kind: "reply",
        body: "Παλιό ευχαριστώ",
        dedupeKey: `feedback-closing-${conversationId}`,
        status: "pending",
      });
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"], reply: "Ευχαριστούμε!" }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("completed");
      expect(harness.repository.outbox).toHaveLength(2);
      expect(harness.repository.outbox[0]).toMatchObject({
        id: legacyId,
        status: "cancelled",
        lastError: "superseded_by_anchored_closing",
      });
      expect(harness.repository.outbox[1]).toMatchObject({
        status: "pending",
        dedupeKey: `feedback-closing-${conversationId}-2-r0`,
      });
    });

    it("parks instead of inserting a second goodbye when the fixed V1 close crossed the provider boundary", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      const legacyId = randomUUID();
      harness.repository.outbox.push({
        id: legacyId,
        conversationId,
        campaignId,
        kind: "reply",
        body: "Παλιό ευχαριστώ",
        dedupeKey: `feedback-closing-${conversationId}`,
        status: "sending",
      });
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"], reply: "Ευχαριστούμε!" }),
      );

      const result = await extractConversation();

      expect(result).toMatchObject({ outcome: "extracted" });
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({ id: legacyId, status: "sending" }),
      ]);
      expect(harness.conversations.get(conversationId)).toMatchObject({
        lifecycle: { state: "open", reason: null },
        awaitingHuman: true,
        needsAttention: true,
        attentionReasons: [
          expect.objectContaining({
            kind: "undelivered_message",
            messageId: null,
            resolvedAt: null,
          }),
        ],
        extraction: { cursorSeq: 2 },
      });
    });

    it("does not close a questionnaire it has just promised to a human", async () => {
      // Κώστας Σβηστομετανιώτης wrote «σβήστε ό,τι σας είπα σας παρακαλώ». The
      // bot said somebody would be in touch, marked the two remaining goals
      // declined, and the conversation closed as `completed` — `awaitingHuman`
      // set on a thread nobody would ever open again. A deletion request is not
      // a refusal to answer; it is work for a person, and it belongs to them.
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({
          handoff: true,
          notes: [handoffNote],
          skippedGoals: ["avoid"],
          reply: "Ας συνεχίσουμε.",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("handoff");
      const conversation = harness.conversations.get(conversationId);
      expect(conversation.lifecycle.state).toBe("open");
      expect(conversation.awaitingHuman).toBe(true);
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({ body: POST_EVENT_FEEDBACK_HANDOFF_REPLY }),
      ]);
    });

    it("keeps the handoff brake when a newer fragment advances the work revision", async () => {
      const executionClaim: FeedbackConversationExecutionClaim = {
        conversationId,
        workRevision: 7,
        epoch: 3,
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: new Date(Date.now() + 60_000),
      };
      const conversation = harness.conversations.get(conversationId);
      conversation.work = {
        revision: 7,
        nextActionAt: new Date(),
        executionEpoch: 3,
      };
      harness.executionFence.renewWithin.mockResolvedValue(executionClaim);
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true, notes: [handoffNote] }),
      );
      harness.conversations.beforeAwaitingHuman = async () => {
        await harness.conversations.appendMessage({
          conversationId,
          actor: "participant",
          text: "και κάτι ακόμη",
          at: new Date(),
          ingressId: randomUUID(),
        });
        conversation.work = {
          revision: 8,
          nextActionAt: new Date(),
          executionEpoch: 3,
        };
      };

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).resolves.toMatchObject({ outcome: "handoff", cursorSeq: 2 });

      expect(conversation.awaitingHuman).toBe(true);
      expect(conversation.extraction.cursorSeq).toBe(2);
      expect(conversation.messages.at(-1)).toMatchObject({
        actor: "participant",
        text: "και κάτι ακόμη",
        seq: 4,
      });
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          status: "pending",
          body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
        }),
      ]);
    });

    it("does not record liked as asked when the bot bows out without mentioning it", async () => {
      // Μπάμπης Διπλογαμωσταυρίδης after sustained abuse: the model named
      // nextGoal liked while writing a withdrawal. The next day's
      // reminder_followup restated liked — a question his transcript never
      // asked. Score was already behind him; liked was the open rung.
      harness.conversations.setGoal(conversationId, "event_score", "answered");
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 1,
        noteType: null,
        text: null,
        extractionMeta: { model, confidence: 1, candidateIds: [] },
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "liked",
          reply: "ΟΚ, το πιάνω — το bot αποσύρεται με σκυμμένο κεφάλι",
        }),
      );

      const result = await extractConversation();

      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: "ΟΚ, το πιάνω — το bot αποσύρεται με σκυμμένο κεφάλι",
          dedupeKey: `feedback-reply-${conversationId}-2`,
        }),
      ]);
      expect(harness.conversations.get(conversationId).lifecycle.state).toBe(
        "open",
      );
      expect(harness.conversations.goalStatuses(conversationId)).toEqual({
        event_score: "answered",
        liked: "skipped",
        meet_again: "skipped",
        avoid: "skipped",
      });
    });

    it("freezes rather than completing when the bot is the one who gave up", async () => {
      // Πάνος Μούλαρος: «Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο» — no
      // answers, no notes, no question. The settled ladder is what stops the
      // reminders; closing on top of it is a different claim, and a wrong one.
      // Μπάμπης's conversation closed as `completed` after one «άντε γαμήσου»,
      // so his next message was answered with «Τέλεια, ευχαριστούμε πολύ! 🙌».
      // Somebody who declines every question is finished; a bot that ran out of
      // things it was willing to say is a conversation for a person to read.
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).not.toBe("completed");
      expect(harness.repository.outbox[0]?.["body"]).toBe(
        "Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο",
      );
      const conversation = harness.conversations.get(conversationId);
      expect(conversation.lifecycle.state).toBe("open");
      expect(conversation.awaitingHuman).toBe(true);
      expect(conversation.needsAttention).toBe(true);
      // The ladder is still settled, so no reminder chases him tomorrow.
      expect(harness.conversations.goalStatuses(conversationId)).toEqual({
        event_score: "skipped",
        liked: "skipped",
        meet_again: "skipped",
        avoid: "skipped",
      });
    });

    it("keeps the conversation open when nothing was extracted but the bot still asked", async () => {
      // Ordinary empty turn: «ναι» yielded nothing, and the bot re-posed the
      // score. That is still going — not a withdrawal — so the ladder stays
      // open for the next answer (or a reminder of the question that was
      // actually asked).
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      expect(harness.conversations.get(conversationId).lifecycle.state).toBe(
        "open",
      );
      expect(
        harness.conversations.goalStatuses(conversationId).event_score,
      ).toBe("asked");
      // Still open on the later rungs — settling them would mean we mistook a
      // re-ask for a withdrawal.
      expect(harness.conversations.goalStatuses(conversationId).liked).toBe(
        "asked",
      );
      expect(harness.conversations.goalStatuses(conversationId).avoid).toBe(
        "asked",
      );
    });

    it("prefers the campaign's launch copy snapshot over the constant", async () => {
      harness.repository.campaigns.set(campaignId, {
        id: campaignId,
        eventId,
        status: "launched",
        questions: { copy: { closing: "Τα λέμε στο επόμενο τραπέζι!" } },
      });
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"] }),
      );

      await extractConversation();

      expect(harness.repository.outbox[0]?.body).toBe(
        "Τα λέμε στο επόμενο τραπέζι!",
      );
    });

    it("keeps the conversation open and skips the closing copy when the finishing turn discloses", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({
          skippedGoals: ["avoid"],
          notes: [
            {
              noteType: "general",
              text: "Ο Κώστας Γ. την έπιασε από τη μέση.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Λυπάμαι πολύ που το ακούω.",
        }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "sexual_misconduct",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.95,
          },
        ]),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("extracted");
      expect(harness.conversations.get(conversationId).lifecycle.state).toBe(
        "open",
      );
      expect(harness.repository.outbox[0]).toMatchObject({
        // The model's words, plus the application's own sentence saying the
        // disclosure reached a person.
        body: `Λυπάμαι πολύ που το ακούω.\n\n${POST_EVENT_FEEDBACK_SAFETY_ASSURANCE}`,
        dedupeKey: `feedback-reply-${conversationId}-2`,
      });
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        true,
      );
      expect(harness.alert.raised).toHaveLength(1);
    });

    it("keeps avoid open under the 9δ hold question so thanks-only cannot close", async () => {
      // Χαρά Παραπεντού (wine_discloses_at_the_finish_line), paid rehearsal
      // run 17: one message declines avoid and describes an incident; the model
      // banks the skip, keeps the note, and asks whether to mark him. Her
      // thanks-only reply then found every goal terminal (avoid still skipped),
      // closed completed, and her «ναι, σημειώστε τον» arrived post-closure.
      // The hold question must reopen avoid to asked so closingNow stays false.
      const holdQuestion =
        'θέλεις τελικά να σημειώσουμε τον Κώστα ή να μείνει το "κανέναν";';
      harness.events.listFeedbackCandidatesForRespondent.mockResolvedValue({
        items: [
          { participantId: nikos, displayName: "Νίκος" },
          { participantId: eleni, displayName: "Ελένη" },
          { participantId: kostas, displayName: "Κώστας Μυτοχωνάκιας" },
        ],
      });
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      for (const row of [
        {
          questionKey: "event_score",
          subjectParticipantId: null as string | null,
          valueInt: 4 as number | null,
        },
        {
          questionKey: "liked",
          subjectParticipantId: nikos,
          valueInt: null,
        },
        {
          questionKey: "meet_again",
          subjectParticipantId: nikos,
          valueInt: null,
        },
      ]) {
        harness.repository.answers.push({
          id: randomUUID(),
          conversationId,
          questionKey: row.questionKey,
          subjectParticipantId: row.subjectParticipantId,
          valueInt: row.valueInt,
          noteType: null,
          text: null,
          extractionMeta: { model, confidence: 1, candidateIds: [] },
        });
      }
      const conversation = harness.conversations.get(conversationId);
      harness.conversations.replaceMessages(conversationId, [
        feedbackStoredMessage({
          id: b1,
          seq: 1,
          actor: "bot",
          text: "Υπάρχει κάποιος που θα προτιμούσες να μην ξαναπετύχεις;",
          at: new Date("2026-07-25T10:01:00.000Z"),
        }),
        feedbackStoredMessage({
          id: p1,
          seq: 2,
          actor: "participant",
          text: "να αποφυγω κανεναν βασικα. αν κ ο Κωστας ο Μυτοχωνακιας με ειχε πιασει απ τη μεση…",
          at: new Date("2026-07-25T10:02:00.000Z"),
        }),
      ]);
      conversation.extraction.cursorSeq = 0;

      harness.generation.propose.mockResolvedValueOnce(
        generation({
          skippedGoals: ["avoid"],
          notes: [
            {
              noteType: "general",
              text: "Ο Κώστας Μυτοχωνάκιας την έπιασε από τη μέση.",
              subjectParticipantId: kostas,
              subjectMentionedName: "Κώστας",
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          nextGoal: "avoid",
          reply: holdQuestion,
        }),
      );
      harness.generation.classifyAttention.mockResolvedValueOnce(
        attentionGeneration([
          {
            category: "sexual_misconduct",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.95,
          },
        ]),
      );

      const disclosure = await extractConversation();

      expect(disclosure.outcome).toBe("extracted");
      expect(harness.conversations.goalStatuses(conversationId).avoid).toBe(
        "asked",
      );
      expect(conversation.lifecycle.state).toBe("open");
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: expect.stringContaining(holdQuestion),
        }),
      ]);
      expect(
        harness.repository.outbox.some((row) =>
          row["dedupeKey"]
            ?.toString()
            .startsWith(`feedback-closing-${conversationId}-`),
        ),
      ).toBe(false);
      // Skip writes no answer row — confirmation later inserts cleanly.
      expect(
        harness.repository.answers.some((row) => row.questionKey === "avoid"),
      ).toBe(false);

      harness.conversations.pushStored(conversationId, {
        id: p2,
        seq: conversation.messages.length + 1,
        actor: "participant",
        text: "ευχαριστω που το ακουσατε",
        at: new Date("2026-07-25T10:03:00.000Z"),
      });
      harness.generation.propose.mockResolvedValueOnce(
        generation({
          reply: "Ευχαριστούμε κι εμείς.",
        }),
      );
      harness.generation.classifyAttention.mockResolvedValueOnce(
        attentionGeneration([]),
      );

      const thanks = await extractConversation();

      expect(thanks.outcome).toBe("extracted");
      expect(conversation.lifecycle.state).toBe("open");
      expect(harness.conversations.goalStatuses(conversationId).avoid).toBe(
        "asked",
      );
      expect(
        harness.repository.outbox.some(
          (row) =>
            row["dedupeKey"]
              ?.toString()
              .startsWith(`feedback-closing-${conversationId}-`) ||
            row["body"] === POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.closing,
        ),
      ).toBe(false);

      harness.conversations.pushStored(conversationId, {
        id: p3,
        seq: conversation.messages.length + 1,
        actor: "participant",
        text: "ναι, σημειωστε τον",
        at: new Date("2026-07-25T10:04:00.000Z"),
      });
      harness.generation.propose.mockResolvedValueOnce(
        generation({
          answers: [
            {
              questionKey: "avoid",
              valueInt: null,
              subjectParticipantId: kostas,
              subjectMentionedName: "Κώστας",
              sourceMessageIds: [p3],
              confidence: 0.95,
            },
          ],
        }),
      );
      harness.generation.classifyAttention.mockResolvedValueOnce(
        attentionGeneration([]),
      );

      const confirmation = await extractConversation();

      expect(confirmation.outcome).toBe("completed");
      expect(harness.conversations.goalStatuses(conversationId).avoid).toBe(
        "answered",
      );
      expect(
        harness.repository.answers.some(
          (row) =>
            row.questionKey === "avoid" && row.subjectParticipantId === kostas,
        ),
      ).toBe(true);
      expect(conversation.lifecycle).toMatchObject({
        state: "closed",
        reason: "completed",
      });
    });
  });

  describe("safety and handoff (D13 amended)", () => {
    it("flags attention and audits, but records the note and keeps the model reply", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          notes: [
            {
              noteType: "general",
              text: "Ο συμμετέχων δεν αντέχει.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Λυπάμαι που το ακούω, θες να μιλήσουμε;",
        }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      const result = await extractConversation();

      // The turn is ordinary: a safety signal is no longer an outcome, a note
      // filter or a copy override — it is an operator flag and nothing else.
      expect(result.outcome).toBe("extracted");
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        true,
      );
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.repository.notes[0]).toMatchObject({
        noteType: "general",
        text: "Ο συμμετέχων δεν αντέχει.",
      });
      expect(harness.generation.classifyAttention).toHaveBeenCalledWith(
        [
          expect.objectContaining({ id: b1, actor: "bot" }),
          expect.objectContaining({ id: p1, actor: "participant" }),
        ],
        [p1],
        expect.any(Function),
      );
      expect(
        harness.conversations
          .get(conversationId)
          .messages.find((message) => message.id === p1)?.attention,
      ).toMatchObject({
        categories: ["other_safety"],
        recommendedAction: "human_follow_up",
        confidence: 0.9,
      });
      expect(harness.repository.outbox[0]).toMatchObject({
        body: `Λυπάμαι που το ακούω, θες να μιλήσουμε;\n\n${POST_EVENT_FEEDBACK_SAFETY_ASSURANCE}`,
        dedupeKey: `feedback-reply-${conversationId}-2`,
      });
      expect(harness.audit.events[0]).toMatchObject({
        action: "feedback_conversation.safety_signalled",
        entityType: "feedback_conversation",
        entityId: conversationId,
      });
    });

    it("raises the operator alert once per false → true attention transition", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ reply: "Είμαστε εδώ." }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await extractConversation();
      // A replay re-asserts the same flag; the seam must stay quiet.
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;
      await extractConversation();

      expect(harness.alert.raised).toHaveLength(1);
      expect(harness.alert.raised[0]).toMatchObject({
        conversationId,
        campaignId,
        reason: "extraction_safety_signal",
        detail: ["other_safety:human_follow_up"],
      });
    });

    it("still swaps in the neutral handoff copy on an explicit handoff", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          handoff: true,
          notes: [handoffNote],
          reply: "Ας συνεχίσουμε.",
        }),
      );

      const result = await extractConversation();

      expect(result.outcome).toBe("handoff");
      expect(harness.repository.outbox[0]).toMatchObject({
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
        dedupeKey: `feedback-handoff-${conversationId}-2`,
      });
    });

    it("keeps the answers a handoff run did extract", async () => {
      // A warranted handoff records what the participant said and *then* asks for
      // a person: the two are independent, and the colleague who picks the
      // conversation up wants the score in front of them rather than a transcript
      // to re-read. Asserted here because it is easy to assume the opposite —
      // the handoff replaces the model's reply, and only the reply.
      harness.generation.propose.mockResolvedValue(
        generation({
          handoff: true,
          answers: [
            {
              questionKey: "event_score",
              valueInt: 5,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Ευχαριστούμε!",
        }),
      );

      const result = await extractConversation();

      expect(result).toMatchObject({ outcome: "handoff", answersWritten: 1 });
      expect(harness.repository.answers).toMatchObject([
        { questionKey: "event_score", valueInt: 5 },
      ]);
      expect(harness.conversations.get(conversationId).awaitingHuman).toBe(
        true,
      );
      expect(harness.repository.outbox[0]).toMatchObject({
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
      });
    });

    it("commits the handoff cursor and bot brake through one atomic transition", async () => {
      const atomicHandoff = vi.spyOn(
        harness.conversations,
        "advanceCursorAndMarkAwaitingHuman",
      );
      const plainCursor = vi.spyOn(harness.conversations, "advanceCursor");
      const plainAwaiting = vi.spyOn(
        harness.conversations,
        "markAwaitingHuman",
      );
      harness.generation.propose.mockResolvedValue(
        generation({
          handoff: true,
          notes: [handoffNote],
          reply: "Κάποιος θα σου μιλήσει.",
        }),
      );

      await extractConversation();

      expect(atomicHandoff).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          conversationId,
          toSeq: 2,
          model,
          usage: { inputTokens: 980, outputTokens: 150, totalTokens: 1_130 },
        }),
      );
      expect(plainCursor).not.toHaveBeenCalled();
      expect(plainAwaiting).not.toHaveBeenCalled();
      expect(harness.conversations.get(conversationId)).toMatchObject({
        extraction: { cursorSeq: 2 },
        awaitingHuman: true,
      });
    });

    it("fails the run rather than obey a handoff that read nothing", async () => {
      // Μαρία Φλερτατζού, twice on 2026-07-27: «βαζω 5. ο Τάσος ήτανε πολύ
      // ωραίος, θα τον ξαναέβλεπα. κανέναν δε θέλω να αποφύγω» came back as a
      // request for a human with nothing extracted and no safety signal. The
      // fixture testimony here is the same shape — a score and a name the run
      // walked past.
      //
      // Nothing may be written, and above all the cursor may not move: the
      // window has to stay open for the retry, which is the only thing that can
      // still read her answers. The failure is retryable for that reason, and if
      // every attempt repeats it BullMQ's last one hands the conversation to the
      // deterministic fallback.
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true, reply: "Κάποιος θα σου μιλήσει." }),
      );

      const failure = await extractConversation().catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(FeedbackExtractionGenerationError);
      expect(failure).toMatchObject({
        retryable: true,
        failureCause: "validation_failed",
      });
      const conversation = harness.conversations.get(conversationId);
      expect(harness.repository.answers).toEqual([]);
      expect(harness.repository.notes).toEqual([]);
      expect(harness.repository.outbox).toEqual([]);
      expect(conversation.extraction.cursorSeq).toBe(0);
      expect(conversation.awaitingHuman).toBe(false);
      expect(conversation.needsAttention).toBe(false);
      expect(harness.alert.raised).toEqual([]);
      expect(harness.audit.events).toEqual([]);
    });

    it("does not seize control; a takeover stays an explicit human action (D17)", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true, notes: [handoffNote] }),
      );

      await extractConversation();

      expect(harness.conversations.get(conversationId).control.mode).toBe(
        "bot",
      );
      expect(harness.audit.events[0]).toMatchObject({
        action: "feedback_conversation.handoff_requested",
      });
    });
  });

  /**
   * The badge on its own was unreadable and unclearable: four unrelated
   * situations arrived as one boolean, so an operator could see that something
   * was wrong and never what. Each raise now names itself and points at a
   * message.
   */
  describe("why the conversation wants a person", () => {
    it("names a safety signal against the message that carried it", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ reply: "Είμαστε εδώ." }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await extractConversation();

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "safety", messageId: p1, resolvedAt: null }]);
    });

    it("answers a recognised data question and files the one nobody has decided", async () => {
      // One message that asks two things: who reads this, and how long it is
      // kept. The first has an approved sentence and it rides out appended to
      // the model's reply; the second is deliberately unanswered, so it earns
      // an `unanswered_data_question` reason a person will read — quiet inbox
      // work, not a page-worthy alert.
      harness.generation.propose.mockResolvedValue(
        generation({ reply: "Καλή ερώτηση! Πάμε στο επόμενο;" }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration(
          [],
          [],
          [],
          [
            { messageId: p1, question: "who_sees_it" },
            { messageId: p1, question: "how_long_kept" },
          ],
        ),
      );

      await extractConversation();

      expect(harness.repository.outbox[0]?.body).toBe(
        `Καλή ερώτηση! Πάμε στο επόμενο;\n\n${POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS.who_sees_it.answer}`,
      );
      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([
        {
          kind: "unanswered_data_question",
          messageId: p1,
          resolvedAt: null,
        },
      ]);
      expect(harness.alert.raised).toHaveLength(0);
    });

    it("says the respondent is the source instead of asking to protect them", async () => {
      // «A message raised a safety concern» reads as «somebody here may need
      // looking after», and under that sentence an operator opens Γεωργία's
      // conversation to see who to support. The person to support is not in it.
      harness.generation.propose.mockResolvedValue(
        generation({ reply: "Το σημείωσα." }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "abuse_of_a_participant",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await extractConversation();

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([
        { kind: "respondent_conduct", messageId: p1, resolvedAt: null },
      ]);
      // And she is not told that somebody will speak to her personally about it.
      expect(harness.repository.outbox[0]?.body).not.toContain(
        POST_EVENT_FEEDBACK_SAFETY_ASSURANCE,
      );
    });

    /**
     * The badge tells a person. This tells the code, and it has to, because the
     * two readers are on different clocks: the operator sees the conversation
     * tonight, and whatever turns avoids into seating reads the row months later
     * with the conversation long closed.
     */
    it("holds an avoid the abuse was the reason for, and leaves the rest alone", async () => {
      // Two things she said in the same burst: the abusive one, and an ordinary
      // compliment. The hold follows the citation, so it lands on the answer the
      // abuse was the reason for and on nothing else.
      harness.conversations.pushStored(conversationId, {
        id: p2,
        seq: 3,
        actor: "participant",
        text: "Ο Νίκος πάντως ήταν γλυκύτατος.",
        at: new Date("2026-07-25T10:03:00.000Z"),
        outboxId: null,
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "avoid",
              valueInt: null,
              subjectParticipantId: eleni,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: null,
              sourceMessageIds: [p2],
              confidence: 0.9,
            },
          ],
          reply: "Το σημείωσα.",
        }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "abuse_of_a_participant",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await extractConversation();

      // The row is recorded — a silent discard would be us deciding on her
      // behalf with nothing on file to say we did — and it is recorded held.
      expect(
        harness.repository.answers.map((row) => [
          row.questionKey,
          row.matchingHold,
        ]),
      ).toStrictEqual([
        ["liked", false],
        ["avoid", true],
      ]);
    });

    it("will not record an answer on a slot an operator withdrew", async () => {
      // The operator read the transcript and removed this row. The participant's
      // words are still in the transcript, so the model proposes it again; the
      // tombstone is what keeps a human's decision from being quietly reversed by
      // the next run, exactly as `extraction_meta.corrections` does for a value.
      harness.repository.answerWithdrawals.push({
        conversationId,
        questionKey: "avoid",
        subjectParticipantId: eleni,
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "avoid",
              valueInt: null,
              subjectParticipantId: eleni,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Το σημείωσα.",
        }),
      );

      const result = await extractConversation();

      expect(harness.repository.answers).toEqual([]);
      expect(result.answersWritten).toBe(0);
    });

    it("names an unattributed note against the message the name was typed in", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          notes: [
            {
              noteType: "general",
              text: "Η Ρούλα ήταν πολύ γλυκιά.",
              subjectParticipantId: null,
              subjectMentionedName: "Ρούλα",
              sourceMessageIds: [p1],
              confidence: 0.6,
            },
          ],
        }),
      );

      await extractConversation();

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "unattributed_note", messageId: p1 }]);
    });

    it("names a refused revision, anchored on the newest message the run read", async () => {
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 4,
        noteType: null,
        text: null,
        extractionMeta: { model, confidence: 1, candidateIds: [] },
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 2,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          reply: "Το άλλαξα σε 2!",
          nextGoal: "liked",
        }),
      );

      await extractConversation();

      // A revision is about the stored row rather than about one line, so the
      // anchor is the burst that proposed it. A reason linking nowhere is the
      // thing worth avoiding.
      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "answer_revision", messageId: p1 }]);
    });

    it("leaves an operator's corrected score alone and asks them to look again", async () => {
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 2,
        noteType: null,
        text: null,
        extractionMeta: {
          model,
          confidence: 1,
          candidateIds: [],
          [FEEDBACK_ANSWER_CORRECTIONS_KEY]: [
            {
              at: "2026-07-27T10:00:00.000Z",
              by: "admin-1",
              from: { valueInt: 4 },
              to: { valueInt: 2 },
            },
          ],
        },
      });
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 4,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
        }),
      );

      await extractConversation();

      // The model reading it as 4 again is exactly how a correction used to be
      // undone: the row went back to 4, `extraction_meta` was replaced, and the
      // only trace of the operator's judgement was a badge. The value stands,
      // the correction stands, and the badge is now the invitation to
      // adjudicate rather than the receipt for a silent revert.
      const stored = harness.repository.answers.filter(
        (row) => row.questionKey === "event_score",
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.valueInt).toBe(2);
      expect(isCorrectedAnswer(stored[0]?.extractionMeta ?? {})).toBe(true);
      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "answer_revision", messageId: p1 }]);
    });

    it("names a handoff, so the badge and the promise say the same thing", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true, notes: [handoffNote] }),
      );

      await extractConversation();

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "handoff", messageId: p1 }]);
    });

    it("names a questionnaire the bot stopped short, not the bot's mood", async () => {
      // Πάνος Μούλαρος again, from the reason list's side. This raise used to be
      // the bare flag: the one situation the inbox could not explain, because
      // naming it `hostile_to_bot` would have been a hostility verdict nobody
      // asked for — rule 7δ withdraws after unanswered attempts, and says in as
      // many words that somebody who swears has not refused to answer.
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο",
        }),
      );

      await extractConversation();

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([
        { kind: "unfinished_questionnaire", messageId: p1, resolvedAt: null },
      ]);
    });

    it("does not stack a withdrawal the run reads twice", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο",
        }),
      );

      await extractConversation();
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;
      await extractConversation();

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toHaveLength(1);
    });

    it("does not stack the same reason when the run replays", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ reply: "Είμαστε εδώ." }),
      );
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await extractConversation();
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;
      await extractConversation();

      // Three identical rows is three dismissals for one thing that happened
      // once, which is how a list stops being read at all.
      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toHaveLength(1);
    });
  });

  describe("replay", () => {
    it("writes nothing new when the same job runs twice", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Ωραία βραδιά.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.6,
            },
          ],
          reply: "Ευχαριστούμε!",
          nextGoal: "event_score",
        }),
      );

      const first = await extractConversation();
      const replay = await extractConversation();

      expect(first.outcome).toBe("extracted");
      // The run appended its own reply, so the transcript did move past the
      // cursor — but only with a bot turn. The replay therefore stops at the
      // no-testimony exit, still before the model is called a second time.
      expect(replay.outcome).toBe("skipped_no_new_testimony");
      expect(harness.generation.propose).toHaveBeenCalledTimes(1);
      expect(harness.repository.answers).toHaveLength(1);
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.repository.outbox).toHaveLength(1);
      // The reply is in the transcript exactly once, correlated to its row.
      const transcript = harness.conversations.get(conversationId).messages;
      expect(
        transcript.filter((message) => message.actor === "bot"),
      ).toHaveLength(2);
      expect(transcript.at(-1)).toMatchObject({
        actor: "bot",
        text: "Ευχαριστούμε!",
        outboxId: harness.repository.outbox[0]?.["id"],
      });
    });

    it("absorbs a crash between the PostgreSQL commit and the cursor advance", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: [p1],
              confidence: 0.9,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Ωραία βραδιά.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: [p1],
              confidence: 0.6,
            },
          ],
          reply: "Ευχαριστούμε!",
          nextGoal: "event_score",
        }),
      );

      await extractConversation();
      // Imported legacy results with a lagging cursor — not a crash the
      // current persist transaction can leave behind.
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;

      const replay = await extractConversation();

      expect(replay.outcome).toBe("extracted");
      expect(replay.answersWritten).toBe(0);
      expect(replay.notesWritten).toBe(0);
      expect(harness.repository.answers).toHaveLength(1);
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.repository.outbox).toHaveLength(1);
      // Three, not two: the first run's reply is now part of the transcript,
      // and the replay reads and settles it along with the rest.
      expect(
        harness.conversations.get(conversationId).extraction.cursorSeq,
      ).toBe(3);
      // The replay re-derived the same testimony-anchored dedupe key and the
      // same `outboxId`, so the reply is neither enqueued nor transcribed
      // twice.
      expect(
        harness.conversations
          .get(conversationId)
          .messages.filter((message) => message.actor === "bot"),
      ).toHaveLength(2);
      expect(harness.repository.outboxLogs).toHaveLength(1);
      expect(harness.repository.outboxLogs[0]).toMatchObject({
        outboxId: harness.repository.outbox[0]?.["id"],
        origin: "extraction_reply",
      });
    });

    it("repairs goal statuses from stored answers after such a replay", async () => {
      harness.repository.answers.push({
        id: randomUUID(),
        conversationId,
        questionKey: "event_score",
        subjectParticipantId: null,
        valueInt: 4,
        noteType: null,
        text: null,
        extractionMeta: { model, confidence: 1, candidateIds: [] },
      });
      harness.generation.propose.mockResolvedValue(generation({}));

      await extractConversation();

      expect(
        harness.conversations.goalStatuses(conversationId).event_score,
      ).toBe("answered");
    });
  });

  describe("transcript capacity after persist", () => {
    const priorOutboxId = "prior-bot-ask";
    const successorOutboxId = "successor-bot-ask";
    const executionClaim: FeedbackConversationExecutionClaim = {
      conversationId,
      workRevision: 7,
      epoch: 3,
      token: "11111111-1111-4111-8111-111111111111",
      leaseUntil: new Date(Date.now() + 60_000),
    };

    function seedPendingReply(id: string): void {
      harness.repository.outbox.push({
        id,
        conversationId,
        campaignId,
        kind: "reply",
        status: "pending",
        sendStartedAt: null,
        body: "Πώς σου φάνηκε η βραδιά;",
        dedupeKey: `feedback-reply-${conversationId}-${id}`,
      });
    }

    function rejectMergeWithCapacity(): void {
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "review",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );
      vi.spyOn(
        harness.conversations,
        "mergeMessageAttention",
      ).mockRejectedValue(new FeedbackConversationCapacityError());
    }

    it("brakes for a human when classifier metadata cannot be stored", async () => {
      // FakeDatabase does not roll persist writes back. The adapter SQL specs
      // already prove CapacityError leaves the caller's transaction usable.
      const conversation = harness.conversations.get(conversationId);
      const testimony = conversation.messages.find(
        (message) => message.id === p1,
      );
      conversation.work = {
        revision: 1,
        nextActionAt: new Date("2026-07-25T10:05:00.000Z"),
        executionEpoch: 0,
      };
      seedPendingReply(priorOutboxId);
      rejectMergeWithCapacity();

      const result = await extractConversation();

      expect(result.outcome).toBe("skipped_awaiting_human");
      expect(result.cursorSeq).toBe(0);
      expect(conversation.extraction.cursorSeq).toBe(0);
      expect(conversation.awaitingHuman).toBe(true);
      expect(conversation.work?.nextActionAt).toBeNull();
      expect(conversation.attentionReasons).toEqual([
        expect.objectContaining({
          kind: "transcript_full",
          messageId: null,
          resolvedAt: null,
        }),
      ]);
      expect(testimony).toMatchObject({
        id: p1,
        text: "5! Ο Νίκος ήταν φοβερός. Η βραδιά κύλησε γρήγορα.",
      });
      expect(testimony?.attention ?? null).toBeNull();
      expect(
        harness.repository.outbox.find((row) => row["id"] === priorOutboxId),
      ).toMatchObject({ status: "cancelled" });

      const firstModelCalls = harness.generation.propose.mock.calls.length;
      const firstAttentionCalls =
        harness.generation.classifyAttention.mock.calls.length;
      const again = await extractConversation();

      expect(again.outcome).toBe("skipped_awaiting_human");
      expect(harness.generation.propose).toHaveBeenCalledTimes(firstModelCalls);
      expect(harness.generation.classifyAttention).toHaveBeenCalledTimes(
        firstAttentionCalls,
      );
      expect(conversation.extraction.cursorSeq).toBe(0);
      expect(testimony?.text).toBe(
        "5! Ο Νίκος ήταν φοβερός. Η βραδιά κύλησε γρήγορα.",
      );
    });

    it("does not park the bot when persist fails for another reason", async () => {
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "review",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );
      vi.spyOn(
        harness.conversations,
        "mergeMessageAttention",
      ).mockRejectedValue(new Error("relation does not exist"));

      await expect(extractConversation()).rejects.toThrow(
        "relation does not exist",
      );

      const conversation = harness.conversations.get(conversationId);
      expect(conversation.awaitingHuman).toBe(false);
      expect(conversation.attentionReasons).toEqual([]);
      expect(conversation.extraction.cursorSeq).toBe(0);
    });

    it("does not silence successor work", async () => {
      const live = harness.conversations.get(conversationId);
      live.work = {
        revision: 7,
        nextActionAt: new Date("2026-07-25T10:05:00.000Z"),
        executionEpoch: 3,
      };
      seedPendingReply(successorOutboxId);
      harness.executionFence.renewWithin.mockResolvedValue(executionClaim);
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "review",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );
      vi.spyOn(
        harness.conversations,
        "mergeMessageAttention",
      ).mockImplementation(async () => {
        live.work = {
          revision: 8,
          nextActionAt: new Date("2026-07-25T10:06:00.000Z"),
          executionEpoch: 3,
        };
        throw new FeedbackConversationCapacityError();
      });

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).rejects.toMatchObject({
        name: FeedbackConversationExecutionGuardError.name,
        reason: "authoritative_state_changed",
      });

      expect(live.awaitingHuman).toBe(false);
      expect(live.attentionReasons).toEqual([]);
      expect(live.extraction.cursorSeq).toBe(0);
      expect(live.work).toMatchObject({ revision: 8, executionEpoch: 3 });
      expect(
        harness.repository.outbox.find(
          (row) => row["id"] === successorOutboxId,
        ),
      ).toMatchObject({ status: "pending" });
    });

    it("does not let a lost execution claim silence successor work", async () => {
      const live = harness.conversations.get(conversationId);
      live.work = {
        revision: 7,
        nextActionAt: new Date("2026-07-25T10:05:00.000Z"),
        executionEpoch: 3,
      };
      seedPendingReply(successorOutboxId);
      harness.executionFence.renewWithin
        .mockResolvedValueOnce(executionClaim)
        .mockResolvedValueOnce(false);
      rejectMergeWithCapacity();

      await expect(
        harness.extractor.extract({
          conversationId,
          correlationId,
          executionClaim,
        }),
      ).rejects.toMatchObject({
        name: FeedbackConversationExecutionGuardError.name,
        reason: "execution_claim_lost",
      });

      expect(live.awaitingHuman).toBe(false);
      expect(live.attentionReasons).toEqual([]);
      expect(
        harness.repository.outbox.find(
          (row) => row["id"] === successorOutboxId,
        ),
      ).toMatchObject({ status: "pending" });
    });
  });

  describe("observability", () => {
    it("logs both model phases per run rather than message count", async () => {
      await extractConversation();

      expect(harness.metrics.totalTokensObserved()).toBe(1_130);
      expect(harness.metrics.countExtract("extracted")).toBe(1);
    });
  });

  describe("operation log", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("records a cheap skip after admit and does not plan a turn", async () => {
      const records = captureOperations();
      harness.conversations.get(conversationId).lifecycle = {
        state: "closed",
        reason: "stopped",
        closedAt: new Date(),
      };

      await expect(extractConversation()).resolves.toMatchObject({
        outcome: "skipped_closed",
      });

      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "completed",
        ),
      ).toMatchObject({
        event: FEEDBACK_OPERATION_EVENT,
        stage: "admit",
        outcome: "skipped_closed",
        conversationId,
        correlationId,
      });
      expect(
        records.some((record) => record.operation === "extract_plan"),
      ).toBe(false);
    });

    it("still proposes, commits, and alerts when the logger sink throws", async () => {
      throwingLoggerSink();
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await expect(extractConversation()).resolves.toMatchObject({
        outcome: "extracted",
      });
      expect(harness.generation.propose).toHaveBeenCalled();
      expect(harness.generation.classifyAttention).toHaveBeenCalled();
      expect(harness.generation.rewriteReply).not.toHaveBeenCalled();
      expect(harness.alert.raised).toEqual([
        expect.objectContaining({
          conversationId,
          reason: "extraction_safety_signal",
        }),
      ]);
      expect(
        harness.summaries.notifyIfLastConversationClosed,
      ).toHaveBeenCalled();
      expect(
        harness.conversations.get(conversationId).extraction.cursorSeq,
      ).toBe(2);
    });

    it("localizes a propose failure and keeps that error", async () => {
      const records = captureOperations();
      const failure = Object.assign(new TypeError("propose unavailable"), {
        code: "PROPOSE_FAILED",
      });
      harness.generation.propose.mockRejectedValue(failure);

      await expect(extractConversation()).rejects.toBe(failure);
      expect(
        records.find(
          (record) =>
            record.operation === "extract_propose" &&
            record.status === "failed",
        ),
      ).toMatchObject({
        stage: "propose",
        errorName: "TypeError",
        errorCode: "PROPOSE_FAILED",
        conversationId,
        correlationId,
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "failed",
        ),
      ).toMatchObject({ stage: "plan_turn" });
      expect(
        records.some((record) => record.operation === "extract_commit"),
      ).toBe(false);
    });

    it("localizes a classify failure on its own run id", async () => {
      const records = captureOperations();
      const classifyFailure = Object.assign(
        new TypeError("classify unavailable"),
        { code: "CLASSIFY_FAILED" },
      );
      const proposeFailure = Object.assign(
        new TypeError("propose unavailable"),
        {
          code: "PROPOSE_FAILED",
        },
      );
      harness.generation.propose.mockRejectedValue(proposeFailure);
      harness.generation.classifyAttention.mockRejectedValue(classifyFailure);

      await expect(extractConversation()).rejects.toSatisfy(
        (error) => error === proposeFailure || error === classifyFailure,
      );
      const proposeFailed = records.find(
        (record) =>
          record.operation === "extract_propose" && record.status === "failed",
      );
      const classifyFailed = records.find(
        (record) =>
          record.operation === "extract_classify" && record.status === "failed",
      );
      expect(proposeFailed).toMatchObject({
        stage: "propose",
        errorName: "TypeError",
        errorCode: "PROPOSE_FAILED",
      });
      expect(classifyFailed).toMatchObject({
        stage: "classify",
        errorName: "TypeError",
        errorCode: "CLASSIFY_FAILED",
      });
      expect(proposeFailed?.runId).not.toBe(classifyFailed?.runId);
      expect(
        records.some((record) => record.operation === "extract_commit"),
      ).toBe(false);
    });

    it("localizes a rewrite failure on a distinct run id", async () => {
      const records = captureOperations();
      const rewriteFailure = Object.assign(
        new TypeError("rewrite unavailable"),
        {
          code: "REWRITE_FAILED",
        },
      );
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Πώς σου φάνηκε συνολικά η βραδιά;",
        }),
      );
      harness.generation.rewriteReply.mockRejectedValue(rewriteFailure);

      await expect(extractConversation()).rejects.toBe(rewriteFailure);
      const rewriteFailed = records.find(
        (record) =>
          record.operation === "extract_rewrite" && record.status === "failed",
      );
      const classifyCompleted = records.find(
        (record) =>
          record.operation === "extract_classify" &&
          record.status === "completed",
      );
      expect(rewriteFailed).toMatchObject({
        stage: "rewrite",
        errorName: "TypeError",
        errorCode: "REWRITE_FAILED",
        conversationId,
        correlationId,
      });
      expect(classifyCompleted).toMatchObject({ stage: "classify" });
      expect(rewriteFailed?.runId).not.toBe(classifyCompleted?.runId);
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "failed",
        ),
      ).toMatchObject({ stage: "plan_turn" });
    });

    it("classifies rewrite supersession without failing the planned turn", async () => {
      const records = captureOperations();
      const failure = new FeedbackConversationExecutionGuardError(
        conversationId,
        "authoritative_state_changed",
      );
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Πώς σου φάνηκε συνολικά η βραδιά;",
        }),
      );
      harness.generation.rewriteReply.mockRejectedValue(failure);

      await expect(extractConversation()).resolves.toMatchObject({
        outcome: "extracted",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract_rewrite" &&
            record.status === "failed",
        ),
      ).toMatchObject({
        stage: "rewrite",
        outcome: "superseded",
        errorName: "FeedbackConversationExecutionGuardError",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract_plan" &&
            record.status === "completed",
        ),
      ).toMatchObject({ outcome: "planned" });
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "completed",
        ),
      ).toMatchObject({ outcome: "extracted" });
    });

    it("keeps a non-capacity persist failure on extract_commit and does not brake", async () => {
      const records = captureOperations();
      const failure = Object.assign(new Error("relation does not exist"), {
        code: "42P01",
      });
      vi.spyOn(
        harness.conversations,
        "mergeMessageAttention",
      ).mockRejectedValue(failure);
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "review",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await expect(extractConversation()).rejects.toBe(failure);
      expect(
        records.find(
          (record) =>
            record.operation === "extract_commit" && record.status === "failed",
        ),
      ).toMatchObject({
        stage: "apply_state_and_transcript",
        errorName: "Error",
        errorCode: "42P01",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "failed",
        ),
      ).toMatchObject({ stage: "commit_turn" });
      expect(
        records.some((record) => record.operation === "extract_capacity_brake"),
      ).toBe(false);
      expect(harness.conversations.get(conversationId).awaitingHuman).toBe(
        false,
      );
    });

    it.each([
      "admit",
      "plan_turn",
      "notify_operator",
      "notify_summary",
    ] as const)(
      "does not mistake a capacity-shaped failure in %s for a failed commit",
      async (stage) => {
        const records = captureOperations();
        const failure = new FeedbackConversationCapacityError();
        if (stage === "admit") {
          vi.spyOn(harness.conversations, "findById").mockRejectedValueOnce(
            failure,
          );
        } else if (stage === "plan_turn") {
          harness.generation.propose.mockRejectedValueOnce(failure);
        } else if (stage === "notify_operator") {
          harness.generation.classifyAttention.mockResolvedValue(
            attentionGeneration([
              {
                category: "other_safety",
                recommendedAction: "review",
                sourceMessageIds: [p1],
                confidence: 0.9,
              },
            ]),
          );
          vi.spyOn(harness.alert, "raise").mockRejectedValueOnce(failure);
        } else {
          harness.summaries.notifyIfLastConversationClosed.mockRejectedValueOnce(
            failure,
          );
        }

        await expect(extractConversation()).rejects.toBe(failure);
        expect(
          records.find(
            (record) =>
              record.operation === "extract" && record.status === "failed",
          ),
        ).toMatchObject({
          stage,
          errorName: "FeedbackConversationCapacityError",
        });
        expect(
          records.some(
            (record) => record.operation === "extract_capacity_brake",
          ),
        ).toBe(false);
      },
    );

    it("brakes only for the original capacity error and records that separate operation", async () => {
      const records = captureOperations();
      vi.spyOn(
        harness.conversations,
        "mergeMessageAttention",
      ).mockRejectedValue(new FeedbackConversationCapacityError());
      harness.generation.classifyAttention.mockResolvedValue(
        attentionGeneration([
          {
            category: "other_safety",
            recommendedAction: "review",
            sourceMessageIds: [p1],
            confidence: 0.9,
          },
        ]),
      );

      await expect(extractConversation()).resolves.toMatchObject({
        outcome: "skipped_awaiting_human",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract_commit" && record.status === "failed",
        ),
      ).toMatchObject({
        stage: "apply_state_and_transcript",
        errorName: "FeedbackConversationCapacityError",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract_capacity_brake" &&
            record.status === "completed",
        ),
      ).toMatchObject({
        stage: "commit_transaction",
        outcome: "skipped_awaiting_human",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "completed",
        ),
      ).toMatchObject({
        stage: "capacity_brake",
        outcome: "skipped_awaiting_human",
      });
    });

    it.each(["begin_transaction", "commit_transaction"])(
      "attributes an extraction transaction failure to %s",
      async (stage) => {
        const records = captureOperations();
        const failure = Object.assign(new Error("transaction failed"), {
          code: "08006",
        });
        const transact = harness.database.transaction.bind(harness.database);
        vi.spyOn(harness.database, "transaction").mockImplementationOnce(
          async (work) => {
            if (stage === "commit_transaction") await transact(work);
            throw failure;
          },
        );

        await expect(extractConversation()).rejects.toBe(failure);
        expect(
          records.find(
            (record) =>
              record.operation === "extract_commit" &&
              record.status === "failed",
          ),
        ).toMatchObject({ stage, errorCode: "08006" });
        expect(
          harness.summaries.notifyIfLastConversationClosed,
        ).not.toHaveBeenCalled();
      },
    );

    it.each(["begin_transaction", "commit_transaction"])(
      "attributes a capacity-brake transaction failure to %s",
      async (stage) => {
        const records = captureOperations();
        const failure = Object.assign(new Error("brake transaction failed"), {
          code: "08006",
        });
        const transact = harness.database.transaction.bind(harness.database);
        const markAwaitingHuman = vi.spyOn(
          harness.conversations,
          "markAwaitingHuman",
        );
        vi.spyOn(harness.database, "transaction")
          .mockRejectedValueOnce(new FeedbackConversationCapacityError())
          .mockImplementationOnce(async (work) => {
            if (stage === "commit_transaction") {
              await transact(work);
            }
            throw failure;
          });

        await expect(extractConversation()).rejects.toBe(failure);
        expect(
          records.find(
            (record) =>
              record.operation === "extract_capacity_brake" &&
              record.status === "failed",
          ),
        ).toMatchObject({ stage, errorCode: "08006" });
        expect(markAwaitingHuman).toHaveBeenCalledTimes(
          stage === "commit_transaction" ? 1 : 0,
        );
      },
    );

    it("leaves an already active human brake alone after capacity rollback", async () => {
      const transact = harness.database.transaction.bind(harness.database);
      const markAwaitingHuman = vi.spyOn(
        harness.conversations,
        "markAwaitingHuman",
      );
      vi.spyOn(harness.database, "transaction")
        .mockRejectedValueOnce(new FeedbackConversationCapacityError())
        .mockImplementationOnce(async (work) => {
          harness.conversations.get(conversationId).awaitingHuman = true;
          return transact(work);
        });

      await expect(extractConversation()).rejects.toMatchObject({
        reason: "authoritative_state_changed",
      });
      expect(markAwaitingHuman).not.toHaveBeenCalled();
      expect(harness.conversations.get(conversationId).awaitingHuman).toBe(
        true,
      );
    });

    it("classifies commit supersession but still throws the same guard error", async () => {
      const records = captureOperations();
      const failure = new FeedbackConversationExecutionGuardError(
        conversationId,
        "authoritative_state_changed",
      );
      vi.spyOn(harness.conversations, "advanceCursor").mockRejectedValue(
        failure,
      );

      await expect(extractConversation()).rejects.toBe(failure);
      expect(
        records.find(
          (record) =>
            record.operation === "extract_commit" && record.status === "failed",
        ),
      ).toMatchObject({
        stage: "apply_state_and_transcript",
        outcome: "superseded",
        errorName: "FeedbackConversationExecutionGuardError",
      });
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "failed",
        ),
      ).toMatchObject({
        stage: "commit_turn",
        outcome: "superseded",
      });
    });

    it("names notify_summary after a committed turn when the last notification fails", async () => {
      const records = captureOperations();
      const failure = Object.assign(new Error("summary notify failed"), {
        code: "NOTIFY_FAILED",
      });
      harness.summaries.notifyIfLastConversationClosed.mockRejectedValue(
        failure,
      );

      await expect(extractConversation()).rejects.toBe(failure);
      expect(
        records.find(
          (record) =>
            record.operation === "extract_commit" &&
            record.status === "completed",
        ),
      ).toMatchObject({ outcome: "committed" });
      expect(
        records.find(
          (record) =>
            record.operation === "extract" && record.status === "failed",
        ),
      ).toMatchObject({
        stage: "notify_summary",
        errorName: "Error",
        errorCode: "NOTIFY_FAILED",
      });
    });
  });

  it("does not retry a job whose conversation is gone", async () => {
    await expect(
      harness.extractor.extract({
        conversationId: randomUUID(),
        correlationId,
        executionClaim: {
          conversationId,
          workRevision: 0,
          epoch: 3,
          token: randomUUID(),
          leaseUntil: new Date(),
        },
      }),
    ).rejects.toThrow(/was not found/u);
  });

  it("does not retry a job whose campaign is gone", async () => {
    harness.repository.campaigns.clear();

    await expect(extractConversation()).rejects.toThrow(
      /campaign .* was not found/iu,
    );
  });
});

interface FakeResultRow {
  id: string;
  conversationId: string;
  questionKey: string | null;
  noteType: string | null;
  text: string | null;
  valueInt: number | null;
  subjectParticipantId: string | null;
  extractionMeta: Record<string, unknown>;
  matchingHold?: boolean;
}

/** One answer slot an operator emptied on purpose. */
interface FakeWithdrawalRow {
  conversationId: string;
  questionKey: string;
  subjectParticipantId: string | null;
}

/** Mirrors the WP2 repository contract the extractor actually depends on. */
interface FakeOutboxLogRow {
  id: string;
  outboxId: string;
  conversationId: string;
  campaignId: string;
  origin: string;
  correlationId: string;
  decision: FeedbackOutboundDecision;
  conversationState: OutboundConversationSnapshot;
  createdAt: Date;
}

class FakeFeedbackRepository {
  readonly campaigns = new Map<
    string,
    {
      id: string;
      eventId: string;
      status: "launched" | "paused" | "closed";
      questions: Record<string, unknown>;
    }
  >();
  readonly answers: FakeResultRow[] = [];
  readonly answerWithdrawals: FakeWithdrawalRow[] = [];
  readonly notes: FakeResultRow[] = [];
  readonly outbox: Record<string, unknown>[] = [];
  readonly outboxLogs: FakeOutboxLogRow[] = [];
  locked = 0;
  newerInboundBeyondSnapshot = false;
  readonly inboundPhoneLocks: string[] = [];

  async findCampaignById(id: string) {
    return this.campaigns.get(id);
  }

  async findCampaignByIdForShare(_transaction: AppTransaction, id: string) {
    return this.findCampaignById(id);
  }

  async listAnswersByConversation(id: string) {
    return this.answers.filter((row) => row.conversationId === id);
  }

  async listNotesByConversation(id: string) {
    return this.notes.filter((row) => row.conversationId === id);
  }

  async listOutboxStatusesByIds(outboxIds: readonly string[]) {
    const selected = new Set(outboxIds);
    return this.outbox.flatMap((row) => {
      const outboxId = row["id"];
      const status = row["status"];
      return typeof outboxId === "string" &&
        typeof status === "string" &&
        selected.has(outboxId)
        ? [{ outboxId, status }]
        : [];
    });
  }

  lockConversation(): Promise<unknown> {
    this.locked += 1;
    return Promise.resolve();
  }

  lockInboundPhone(
    _transaction: AppTransaction,
    phoneE164: string,
  ): Promise<void> {
    this.inboundPhoneLocks.push(phoneE164);
    return Promise.resolve();
  }

  hasInboundBeyondSnapshot(): Promise<boolean> {
    return Promise.resolve(this.newerInboundBeyondSnapshot);
  }

  /** Moving a person between mutually exclusive questions clears the old one. */
  async deleteContradictedAnswers(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      subjectParticipantId: string;
      questionKeys: readonly string[];
    },
  ): Promise<number> {
    const before = this.answers.length;
    for (let index = this.answers.length - 1; index >= 0; index -= 1) {
      const row = this.answers[index];
      if (
        row &&
        row.conversationId === input.conversationId &&
        row.subjectParticipantId === input.subjectParticipantId &&
        row.questionKey !== null &&
        input.questionKeys.includes(row.questionKey) &&
        // A row an operator corrected is not the model's to delete.
        !isCorrectedAnswer(row.extractionMeta)
      ) {
        this.answers.splice(index, 1);
      }
    }
    return before - this.answers.length;
  }

  /** `ON CONFLICT DO UPDATE` on (conversation, question_key, subject). */
  async insertAnswerIfAbsent(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      questionKey: string;
      subjectParticipantId?: string | null;
      valueInt?: number | null;
      extractionMeta: Record<string, unknown>;
      matchingHold?: boolean;
    },
  ): Promise<FakeResultRow | undefined> {
    const subject = input.subjectParticipantId ?? null;
    // The withdrawal freeze: an operator emptied this slot on purpose, and the
    // row they deleted is gone, so the tombstone is what says so.
    if (
      this.answerWithdrawals.some(
        (tombstone) =>
          tombstone.conversationId === input.conversationId &&
          tombstone.questionKey === input.questionKey &&
          tombstone.subjectParticipantId === subject,
      )
    ) {
      return undefined;
    }
    const existing = this.answers.find(
      (row) =>
        row.conversationId === input.conversationId &&
        row.questionKey === input.questionKey &&
        row.subjectParticipantId === subject,
    );
    if (existing) {
      // `setWhere: not (extraction_meta ? 'corrections')` — a corrected row is
      // frozen and the conflicting insert writes nothing.
      if (isCorrectedAnswer(existing.extractionMeta)) {
        return undefined;
      }
      const carried = existing.extractionMeta[FEEDBACK_ANSWER_CORRECTIONS_KEY];
      existing.valueInt = input.valueInt ?? null;
      // `matching_hold or excluded.matching_hold`: a hold only accumulates.
      existing.matchingHold =
        existing.matchingHold === true || input.matchingHold === true;
      existing.extractionMeta = {
        ...input.extractionMeta,
        ...(carried === undefined
          ? {}
          : { [FEEDBACK_ANSWER_CORRECTIONS_KEY]: carried }),
      };
      return existing;
    }
    const row: FakeResultRow = {
      id: randomUUID(),
      conversationId: input.conversationId,
      questionKey: input.questionKey,
      noteType: null,
      text: null,
      valueInt: input.valueInt ?? null,
      subjectParticipantId: subject,
      extractionMeta: input.extractionMeta,
      matchingHold: input.matchingHold === true,
    };
    this.answers.push(row);
    return row;
  }

  async insertNote(
    _transaction: AppTransaction,
    input: {
      conversationId: string;
      noteType: string;
      text: string;
      subjectParticipantId?: string | null;
      extractionMeta: Record<string, unknown>;
    },
  ): Promise<FakeResultRow> {
    const row: FakeResultRow = {
      id: randomUUID(),
      conversationId: input.conversationId,
      questionKey: null,
      noteType: input.noteType,
      text: input.text,
      valueInt: null,
      subjectParticipantId: input.subjectParticipantId ?? null,
      extractionMeta: input.extractionMeta,
    };
    this.notes.push(row);
    return row;
  }

  async insertOutboxIfAbsent(
    _transaction: AppTransaction,
    input: { dedupeKey: string } & Record<string, unknown>,
  ): Promise<{ row: Record<string, unknown>; inserted: boolean }> {
    const existing = this.outbox.find(
      (row) => row["dedupeKey"] === input.dedupeKey,
    );
    if (existing) {
      return { row: existing, inserted: false };
    }
    const row = { id: randomUUID(), status: "pending", ...input };
    this.outbox.push(row);
    return { row, inserted: true };
  }

  async resolveLegacyClosingBeforeAnchoredInsert(
    _transaction: AppTransaction,
    legacyDedupeKey: string,
  ): Promise<
    | { outcome: "clear" }
    | { outcome: "provider_crossed"; row: Record<string, unknown> }
  > {
    const legacy = this.outbox.find(
      (row) => row["dedupeKey"] === legacyDedupeKey,
    );
    if (
      !legacy ||
      legacy["status"] === "failed" ||
      legacy["status"] === "cancelled"
    ) {
      return { outcome: "clear" };
    }
    if (
      ["attempting", "ambiguous", "sending", "sent"].includes(
        String(legacy["status"]),
      ) ||
      legacy["sendStartedAt"] != null
    ) {
      return { outcome: "provider_crossed", row: legacy };
    }
    if (["pending", "held", "claimed"].includes(String(legacy["status"]))) {
      legacy["status"] = "cancelled";
      legacy["claimExpiresAt"] = null;
      legacy["lastError"] = "superseded_by_anchored_closing";
    }
    return { outcome: "clear" };
  }

  async cancelQueuedOutboxById(
    _transaction: AppTransaction,
    id: string,
    lastError?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = this.outbox.find((candidate) => candidate["id"] === id);
    if (
      !row ||
      !["pending", "held", "claimed"].includes(String(row["status"]))
    ) {
      return undefined;
    }
    row["status"] = "cancelled";
    row["lastError"] = lastError ?? null;
    return row;
  }

  async cancelQueuedOutboxForConversationExceptId(
    _transaction: AppTransaction,
    targetConversationId: string,
    authorizedOutboxId: string | null,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row["conversationId"] !== targetConversationId ||
        row["id"] === authorizedOutboxId ||
        !["pending", "held", "claimed"].includes(String(row["status"])) ||
        row["sendStartedAt"] != null
      ) {
        continue;
      }
      row["status"] = "cancelled";
      row["claimExpiresAt"] = null;
      cancelled += 1;
    }
    return cancelled;
  }

  async cancelQueuedAutomatedOutboxForConversation(
    _transaction: AppTransaction,
    targetConversationId: string,
    authorizedOutboxId?: string | null,
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.outbox) {
      if (
        row["conversationId"] !== targetConversationId ||
        row["kind"] === "staff" ||
        row["id"] === authorizedOutboxId ||
        !["pending", "held", "claimed"].includes(String(row["status"])) ||
        row["sendStartedAt"] != null
      ) {
        continue;
      }
      row["status"] = "cancelled";
      row["claimExpiresAt"] = null;
      cancelled += 1;
    }
    return cancelled;
  }

  async insertOutboxLogIfAbsent(
    _transaction: AppTransaction,
    input: {
      outboxId: string;
      conversationId: string;
      campaignId: string;
      origin: string;
      correlationId: string;
      decision: FeedbackOutboundDecision;
      conversationState: OutboundConversationSnapshot;
    },
  ): Promise<{ row: FakeOutboxLogRow; inserted: boolean }> {
    const existing = this.outboxLogs.find(
      (row) => row.outboxId === input.outboxId,
    );
    if (existing) {
      return { row: { ...existing }, inserted: false };
    }
    const row: FakeOutboxLogRow = {
      id: randomUUID(),
      outboxId: input.outboxId,
      conversationId: input.conversationId,
      campaignId: input.campaignId,
      origin: input.origin,
      correlationId: input.correlationId,
      decision: input.decision,
      conversationState: input.conversationState,
      createdAt: new Date(),
    };
    this.outboxLogs.push(row);
    return { row: { ...row }, inserted: true };
  }
}

interface Harness {
  extractor: PostEventFeedbackExtractor;
  database: FakeDatabase;
  repository: FakeFeedbackRepository;
  conversations: FakeFeedbackConversations;
  participants: FakeParticipants;
  events: {
    listFeedbackCandidatesForRespondent: ReturnType<typeof vi.fn>;
    getFeedbackVenueContext: ReturnType<typeof vi.fn>;
    feedbackVenueContextIsCurrent: ReturnType<typeof vi.fn>;
  };
  generation: {
    serviceTier: string | undefined;
    propose: ReturnType<typeof vi.fn>;
    rewriteReply: ReturnType<typeof vi.fn>;
    classifyAttention: ReturnType<typeof vi.fn>;
  };
  executionFence: {
    renewWithin: ReturnType<typeof vi.fn>;
    isCurrent: ReturnType<typeof vi.fn>;
    assertCurrent: ReturnType<typeof vi.fn>;
  };
  audit: FakeAudit;
  metrics: PostEventFeedbackMetrics;
  alert: {
    raised: FeedbackOperatorAlertInput[];
    raise(input: FeedbackOperatorAlertInput): Promise<void>;
  };
  summaries: {
    notifyIfLastConversationClosed: ReturnType<typeof vi.fn>;
  };
}

/**
 * Cases here are written as "the model proposed these answers", which is what
 * they are about. The wire shape is one verdict per goal; translating in the
 * factory keeps each case a claim about the extractor rather than about
 * serialization.
 */
function generation(
  overrides: Record<string, unknown> & {
    readonly answers?: readonly FeedbackExtractionAnswerProposal[];
    readonly skippedGoals?: readonly FeedbackAnswerQuestionKey[];
  },
): Record<string, unknown> {
  const { answers, skippedGoals, ...rest } = overrides;
  return {
    model,
    usage: { inputTokens: 800, outputTokens: 110, totalTokens: 910 },
    proposal: {
      goals: feedbackExtractionGoalVerdicts({
        ...(answers ? { answered: answers } : {}),
        declined: (skippedGoals ?? []).map((questionKey) => ({
          questionKey,
          sourceMessageIds: ["m2"],
        })),
      }),
      notes: [],
      nextGoal: null,
      reply: null,
      handoff: false,
      confidence: 0.9,
      ...rest,
    },
  };
}

/**
 * `describedIncidentMessageIds` defaults to every message the signals cite,
 * which is what "an incident was classified" meant before the classifier could
 * tell a description from an announcement. A case about the announcement passes
 * an explicit empty list.
 */
function attentionGeneration(
  signals: readonly Record<string, unknown>[],
  hostileMessageIds: readonly string[] = [],
  describedIncidentMessageIds: readonly string[] = [
    ...new Set(
      signals.flatMap((signal) => (signal.sourceMessageIds ?? []) as string[]),
    ),
  ],
  policyQuestions: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    model,
    usage: { inputTokens: 180, outputTokens: 40, totalTokens: 220 },
    estimatedPromptTokens: 200,
    signals,
    hostileMessageIds,
    describedIncidentMessageIds,
    policyQuestions,
  };
}

function createHarness(): Harness {
  const repository = new FakeFeedbackRepository();
  const conversations = new FakeFeedbackConversations();
  const participants = new FakeParticipants();
  const audit = new FakeAudit();
  const metrics = new PostEventFeedbackMetrics();
  const events = {
    listFeedbackCandidatesForRespondent: vi.fn().mockResolvedValue({
      items: [
        { participantId: nikos, displayName: "Νίκος" },
        { participantId: eleni, displayName: "Ελένη" },
      ],
    }),
    getFeedbackVenueContext: vi.fn().mockResolvedValue({
      contextRevision: 0,
      venue: null,
    } satisfies EventFeedbackVenueSnapshot),
    feedbackVenueContextIsCurrent: vi.fn().mockResolvedValue(true),
  };
  const generationService = {
    // Mutable so a case can put the model on OpenAI's fast lane, which is the
    // only thing that makes the persisted tier anything but null.
    serviceTier: undefined as string | undefined,
    propose: vi.fn().mockResolvedValue(generation({})),
    rewriteReply: vi
      .fn()
      .mockImplementation(async (_prompt: unknown, draft: string) => ({
        model,
        reply: draft,
        usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120 },
        estimatedPromptTokens: 100,
      })),
    classifyAttention: vi.fn().mockResolvedValue(attentionGeneration([])),
  };
  const alert = {
    raised: [] as FeedbackOperatorAlertInput[],
    async raise(input: FeedbackOperatorAlertInput): Promise<void> {
      this.raised.push(input);
    },
  };
  const summaries = {
    notifyIfLastConversationClosed: vi.fn().mockResolvedValue(undefined),
  };

  repository.campaigns.set(campaignId, {
    id: campaignId,
    eventId,
    status: "launched",
    questions: {},
  });
  participants.rows.set(respondentId, {
    id: respondentId,
    preferredName: null,
    emailNormalized: `${respondentId}@example.test`,
    phoneE164: null,
    postEventFeedbackWhatsappOptIn: true,
  });
  conversations.seed(
    feedbackConversationFixture({
      _id: conversationId,
      campaignId,
      respondentParticipantId: respondentId,
      phoneAtLaunch: "+306900000001",
      control: {
        mode: "bot",
        source: "launch",
        changedAt: new Date("2026-07-25T10:00:00.000Z"),
      },
      goals: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.map(
        (question, index) => ({
          key: question.key,
          ordinal: index + 1,
          prompt: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy[question.key],
          status: "asked" as const,
        }),
      ),
      messages: [
        feedbackStoredMessage({
          id: b1,
          seq: 1,
          actor: "bot",
          text: "Πώς σου φάνηκε η βραδιά;",
          at: new Date("2026-07-25T10:01:00.000Z"),
        }),
        feedbackStoredMessage({
          id: p1,
          seq: 2,
          actor: "participant",
          text: "5! Ο Νίκος ήταν φοβερός. Η βραδιά κύλησε γρήγορα.",
          at: new Date("2026-07-25T10:02:00.000Z"),
        }),
      ],
    }),
  );

  const database = new FakeDatabase();
  const executionFence = {
    renewWithin: vi
      .fn()
      .mockImplementation(async (_transaction, claim) => claim),
    isCurrent: vi.fn().mockResolvedValue(true),
    assertCurrent: vi.fn().mockResolvedValue(true),
  };
  const outboundTranscript = new FeedbackOutboundTranscriptService(
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
  );
  const outboundIntent = new FeedbackOutboundIntentService(
    repository as unknown as FeedbackOutboxRepository,
    repository as unknown as FeedbackOutboundLogRepository,
  );
  const guards = new FeedbackExtractionGuards(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackIngressRepository,
    repository as unknown as FeedbackResultsRepository,
    executionFence as never,
    repository as unknown as FeedbackCampaignRepository,
    participants as unknown as ParticipantsRepository,
    conversations as unknown as FeedbackConversationRepository,
  );
  const admission = new FeedbackExtractionAdmissionService(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackCampaignRepository,
    repository as unknown as FeedbackResultsRepository,
    conversations as unknown as FeedbackConversationRepository,
    participants as unknown as ParticipantsRepository,
    executionFence as never,
  );
  const modelContext = new FeedbackModelContextBuilder(
    events as unknown as EventsService,
    repository as unknown as FeedbackResultsRepository,
    participants as unknown as ParticipantsRepository,
    repository as unknown as FeedbackOutboxRepository,
    guards,
  );
  const aiTurn = new FeedbackAiTurnAnalysis(
    generationService as unknown as PostEventFeedbackExtractionModel,
    metrics,
  );
  const participantReply = new FeedbackParticipantReplyPlanner(
    generationService as unknown as PostEventFeedbackExtractionModel,
    metrics,
    guards,
  );
  const turns = new FeedbackExtractionTurnService(
    modelContext,
    aiTurn,
    participantReply,
  );
  const resultsWriter = new FeedbackExtractionResultsWriter(
    repository as unknown as FeedbackResultsRepository,
    audit as unknown as AuditRepository,
  );
  const state = new FeedbackExtractionStateApplier(
    repository as unknown as FeedbackResultsRepository,
    conversations as unknown as FeedbackConversationRepository,
    repository as unknown as FeedbackOutboxRepository,
  );
  const capacity = new FeedbackExtractionCapacityService(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackResultsRepository,
    executionFence as never,
    conversations as unknown as FeedbackConversationRepository,
    repository as unknown as FeedbackOutboxRepository,
  );
  const commits = new FeedbackExtractionCommitService(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackIngressRepository,
    events as unknown as EventsService,
    repository as unknown as FeedbackResultsRepository,
    executionFence as never,
    conversations as unknown as FeedbackConversationRepository,
    repository as unknown as FeedbackOutboxRepository,
    outboundTranscript,
    outboundIntent,
    resultsWriter,
    state,
  );
  const extractor = new PostEventFeedbackExtractor(
    admission,
    turns,
    commits,
    capacity,
    metrics,
    alert,
    summaries as never,
  );

  return {
    extractor,
    database,
    repository,
    conversations,
    participants,
    events,
    generation: generationService,
    executionFence,
    audit,
    metrics,
    alert,
    summaries,
  };
}

function captureOperations(): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const collect = (message: unknown) => {
    if (
      message !== null &&
      typeof message === "object" &&
      "event" in message &&
      message.event === FEEDBACK_OPERATION_EVENT
    ) {
      records.push(message as Record<string, unknown>);
    }
  };
  vi.spyOn(Logger.prototype, "log").mockImplementation(collect);
  vi.spyOn(Logger.prototype, "error").mockImplementation(collect);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(collect);
  return records;
}

function throwingLoggerSink(): void {
  const boom = () => {
    throw new Error("pino unavailable");
  };
  vi.spyOn(Logger.prototype, "log").mockImplementation(boom);
  vi.spyOn(Logger.prototype, "error").mockImplementation(boom);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(boom);
}
