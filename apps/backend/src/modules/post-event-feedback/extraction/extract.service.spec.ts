import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import {
  accumulateFeedbackExtractionUsage,
  type FeedbackConversationExtractionUsage,
} from "../post-event-feedback-conversation.document.js";
import type { EventsService } from "../../events/events.service.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackOperatorAlertInput } from "../operator-alert.js";
import type { FeedbackOutboundLogRepository } from "../outbox/outbound-log.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeParticipants,
} from "../post-event-feedback-doubles.harness.js";
import type { FeedbackOutboundDecision } from "../outbox/outbound-log.schemas.js";
import type { OutboundConversationSnapshot } from "../outbox/outbound-log.snapshot.js";
import {
  FEEDBACK_ANSWER_CORRECTIONS_KEY,
  isCorrectedAnswer,
} from "./answer-corrections.js";
import { PostEventFeedbackExtractor } from "./extract.service.js";
import {
  FeedbackExtractionGenerationError,
  type PostEventFeedbackExtractionModel,
} from "./model.service.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "../question-set.js";
import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  POST_EVENT_FEEDBACK_SAFETY_ASSURANCE,
  feedbackExtractionGoalVerdicts,
  type FeedbackExtractionAnswerProposal,
} from "./extraction.schemas.js";
import { POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS } from "./policy-answers.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "./results.repository.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const eventId = "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10";
const respondentId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
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
  sourceMessageIds: ["p1"],
  confidence: 0.9,
} as const;

describe("PostEventFeedbackExtractor", () => {
  let harness: Harness;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    harness = createHarness();
  });

  describe("cheap exits", () => {
    it("skips a closed conversation without calling the model", async () => {
      harness.conversations.get(conversationId).lifecycle = {
        state: "closed",
        reason: "stopped",
        closedAt: new Date(),
      };

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_closed");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("skips a conversation under human control", async () => {
      harness.conversations.get(conversationId).control = {
        mode: "human",
        source: "staff_action",
        changedAt: new Date(),
      };

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_human_control");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("skips when the cursor already covers the transcript", async () => {
      harness.conversations.get(conversationId).extraction.cursorSeq = 2;

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_cursor");
      expect(harness.generation.propose).not.toHaveBeenCalled();
    });

    it("advances the cursor without a model call when only the bot spoke", async () => {
      const conversation = harness.conversations.get(conversationId);
      conversation.messages = [
        { id: "b1", seq: 1, actor: "bot", text: "Καλησπέρα!", at: new Date() },
      ];
      conversation.extraction.cursorSeq = 0;

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("skipped_no_new_testimony");
      expect(harness.generation.propose).not.toHaveBeenCalled();
      expect(conversation.extraction.cursorSeq).toBe(1);
    });
  });

  describe("the extraction run", () => {
    it("persists answers and notes with the run's model, confidence and candidate ids", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          answers: [
            {
              questionKey: "event_score",
              valueInt: 5,
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.95,
            },
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: "Νίκος",
              sourceMessageIds: ["p1"],
              confidence: 0.8,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Η βραδιά κύλησε γρήγορα.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
          nextGoal: "meet_again",
          reply: "Ευχαριστούμε! Με ποιους θα ήθελες να ξαναβρεθείς;",
        }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

      await harness.extractor.extract({ conversationId, correlationId });

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

    it("adds the next run's tokens to what the conversation already spent", async () => {
      await harness.extractor.extract({ conversationId, correlationId });

      const conversation = harness.conversations.get(conversationId);
      conversation.messages.push({
        id: "p2",
        seq: conversation.messages.length + 1,
        actor: "participant",
        text: "Α, και το φαγητό ήταν πολύ καλό.",
        at: new Date("2026-07-25T10:06:00.000Z"),
      });

      await harness.extractor.extract({ conversationId, correlationId });

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

      await harness.extractor.extract({ conversationId, correlationId });

      // Not 800/110/910. The extraction phase's numbers are real, but they are
      // not this run's cost, and a total that presents them as one is wrong in
      // the direction that flatters us.
      expect(
        harness.conversations.get(conversationId).extraction.usage,
      ).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    });

    it("never bills a run that advanced the cursor without calling the model", async () => {
      await harness.extractor.extract({ conversationId, correlationId });
      const conversation = harness.conversations.get(conversationId);
      const afterFirstRun = { ...conversation.extraction.usage };

      // Only the bot spoke since. The cursor still moves — those messages are
      // read and settled — but no provider was reached, so nothing was bought.
      conversation.messages.push({
        id: "b2",
        seq: conversation.messages.length + 1,
        actor: "bot",
        text: "Ευχαριστούμε!",
        at: new Date("2026-07-25T10:07:00.000Z"),
      });

      const replay = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(replay.outcome).toBe("skipped_no_new_testimony");
      expect(harness.generation.propose).toHaveBeenCalledTimes(1);
      expect(conversation.extraction.usage).toEqual(afterFirstRun);
    });

    it("selects candidates live for every run rather than from the document", async () => {
      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.events.listFeedbackCandidatesForRespondent,
      ).toHaveBeenCalledWith(eventId, respondentId);
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
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          reply: "Το άλλαξα σε 2!",
          nextGoal: "liked",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

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

      await harness.extractor.extract({ conversationId, correlationId });

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

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("completed");
      const closing = harness.repository.outbox[0];
      expect(closing).toMatchObject({
        dedupeKey: `feedback-closing-${conversationId}`,
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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
          reply: "Ποιος σου έκανε εντύπωση;",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
          reply: "Τέλεια, χαίρομαι πολύ! 🙂",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

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
              sourceMessageIds: ["p1"],
              confidence: 0.8,
            },
            {
              questionKey: "meet_again",
              valueInt: null,
              subjectParticipantId: null,
              subjectMentionedName: "Μαρη",
              sourceMessageIds: ["p1"],
              confidence: 0.8,
            },
          ],
          skippedGoals: ["avoid"],
          nextGoal: null,
          reply: "Ευχαριστούμε για το feedback 🙂",
        }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

    it("never sends when opt-in was withdrawn, but still keeps the answers", async () => {
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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          reply: "Ευχαριστούμε!",
          nextGoal: "event_score",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.repository.answers).toHaveLength(1);
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
        });
        return generation(overrides);
      });
    };

    it("drops the ordinary reply, which now answers a thought that moved on", async () => {
      typesDuringTheRun();

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("extracted");
      // The run reading the newer message speaks instead: one reply per burst,
      // not one per fragment.
      expect(harness.repository.outbox).toEqual([]);
    });

    it("still writes its results and closes its own window", async () => {
      typesDuringTheRun({
        answers: [
          {
            questionKey: "event_score",
            valueInt: 5,
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ],
        nextGoal: "liked",
        reply: "Ευχαριστούμε πολύ!",
      });

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

    it("still sends the closing copy, because a closed conversation never speaks again", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      typesDuringTheRun({ reply: null });

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("completed");
      expect(harness.repository.outbox[0]).toMatchObject({
        dedupeKey: `feedback-closing-${conversationId}`,
      });
    });

    it("still sends the handoff copy, because it promises a human", async () => {
      typesDuringTheRun({
        handoff: true,
        notes: [handoffNote],
        reply: "Ευχαριστούμε πολύ!",
      });

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("handoff");
      expect(harness.repository.outbox[0]).toMatchObject({
        body: POST_EVENT_FEEDBACK_HANDOFF_REPLY,
      });
    });
  });

  describe("completion", () => {
    it("closes as completed and sends the campaign's closing copy once", async () => {
      harness.conversations.setAllGoals(conversationId, "answered");
      harness.conversations.setGoal(conversationId, "avoid", "asked");
      harness.generation.propose.mockResolvedValue(
        generation({ skippedGoals: ["avoid"], reply: "Ευχαριστούμε!" }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
          dedupeKey: `feedback-closing-${conversationId}`,
        }),
      ]);
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

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(result.outcome).toBe("handoff");
      const conversation = harness.conversations.get(conversationId);
      expect(conversation.lifecycle.state).toBe("open");
      expect(conversation.awaitingHuman).toBe(true);
      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({ body: POST_EVENT_FEEDBACK_HANDOFF_REPLY }),
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

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(harness.repository.outbox).toEqual([
        expect.objectContaining({
          body: "ΟΚ, το πιάνω — το bot αποσύρεται με σκυμμένο κεφάλι",
        }),
      ]);
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

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

      await harness.extractor.extract({ conversationId, correlationId });

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
              sourceMessageIds: ["p1"],
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
            sourceMessageIds: ["p1"],
            confidence: 0.95,
          },
        ]),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
      conversation.messages = [
        {
          id: "b1",
          seq: 1,
          actor: "bot",
          text: "Υπάρχει κάποιος που θα προτιμούσες να μην ξαναπετύχεις;",
          at: new Date("2026-07-25T10:01:00.000Z"),
        },
        {
          id: "p1",
          seq: 2,
          actor: "participant",
          text: "να αποφυγω κανεναν βασικα. αν κ ο Κωστας ο Μυτοχωνακιας με ειχε πιασει απ τη μεση…",
          at: new Date("2026-07-25T10:02:00.000Z"),
        },
      ];
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
              sourceMessageIds: ["p1"],
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
            sourceMessageIds: ["p1"],
            confidence: 0.95,
          },
        ]),
      );

      const disclosure = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
        harness.repository.outbox.some(
          (row) => row["dedupeKey"] === `feedback-closing-${conversationId}`,
        ),
      ).toBe(false);
      // Skip writes no answer row — confirmation later inserts cleanly.
      expect(
        harness.repository.answers.some((row) => row.questionKey === "avoid"),
      ).toBe(false);

      conversation.messages.push({
        id: "p2",
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

      const thanks = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(thanks.outcome).toBe("extracted");
      expect(conversation.lifecycle.state).toBe("open");
      expect(harness.conversations.goalStatuses(conversationId).avoid).toBe(
        "asked",
      );
      expect(
        harness.repository.outbox.some(
          (row) =>
            row["dedupeKey"] === `feedback-closing-${conversationId}` ||
            row["body"] === POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.closing,
        ),
      ).toBe(false);

      conversation.messages.push({
        id: "p3",
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
              sourceMessageIds: ["p3"],
              confidence: 0.95,
            },
          ],
        }),
      );
      harness.generation.classifyAttention.mockResolvedValueOnce(
        attentionGeneration([]),
      );

      const confirmation = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

      expect(confirmation.outcome).toBe("completed");
      expect(harness.conversations.goalStatuses(conversationId).avoid).toBe(
        "answered",
      );
      expect(
        harness.repository.answers.some(
          (row) =>
            row.questionKey === "avoid" &&
            row.subjectParticipantId === kostas,
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
              sourceMessageIds: ["p1"],
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
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ]),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
          expect.objectContaining({ id: "b1", actor: "bot" }),
          expect.objectContaining({ id: "p1", actor: "participant" }),
        ],
        ["p1"],
      );
      expect(
        harness.conversations
          .get(conversationId)
          .messages.find((message) => message.id === "p1")?.attention,
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
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ]),
      );

      await harness.extractor.extract({ conversationId, correlationId });
      // A replay re-asserts the same flag; the seam must stay quiet.
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;
      await harness.extractor.extract({ conversationId, correlationId });

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

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          reply: "Ευχαριστούμε!",
        }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

      const failure = await harness.extractor
        .extract({ conversationId, correlationId })
        .catch((error: unknown) => error);

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

      await harness.extractor.extract({ conversationId, correlationId });

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
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ]),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "safety", messageId: "p1", resolvedAt: null }]);
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
            { messageId: "p1", question: "who_sees_it" },
            { messageId: "p1", question: "how_long_kept" },
          ],
        ),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.repository.outbox[0]?.body).toBe(
        `Καλή ερώτηση! Πάμε στο επόμενο;\n\n${POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS.who_sees_it.answer}`,
      );
      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([
        {
          kind: "unanswered_data_question",
          messageId: "p1",
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
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ]),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([
        { kind: "respondent_conduct", messageId: "p1", resolvedAt: null },
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
      harness.conversations.get(conversationId).messages.push({
        id: "p2",
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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
            {
              questionKey: "liked",
              valueInt: null,
              subjectParticipantId: nikos,
              subjectMentionedName: null,
              sourceMessageIds: ["p2"],
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
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ]),
      );

      await harness.extractor.extract({ conversationId, correlationId });

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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          reply: "Το σημείωσα.",
        }),
      );

      const result = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "unattributed_note", messageId: "p1" }]);
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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          reply: "Το άλλαξα σε 2!",
          nextGoal: "liked",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      // A revision is about the stored row rather than about one line, so the
      // anchor is the burst that proposed it. A reason linking nowhere is the
      // thing worth avoiding.
      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "answer_revision", messageId: "p1" }]);
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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          nextGoal: "liked",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

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
      ).toMatchObject([{ kind: "answer_revision", messageId: "p1" }]);
    });

    it("names a handoff, so the badge and the promise say the same thing", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true, notes: [handoffNote] }),
      );

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([{ kind: "handoff", messageId: "p1" }]);
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

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.get(conversationId).attentionReasons,
      ).toMatchObject([
        { kind: "unfinished_questionnaire", messageId: "p1", resolvedAt: null },
      ]);
    });

    it("does not stack a withdrawal the run reads twice", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({
          nextGoal: "event_score",
          reply: "Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;
      await harness.extractor.extract({ conversationId, correlationId });

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
            sourceMessageIds: ["p1"],
            confidence: 0.9,
          },
        ]),
      );

      await harness.extractor.extract({ conversationId, correlationId });
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;
      await harness.extractor.extract({ conversationId, correlationId });

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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Ωραία βραδιά.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
          reply: "Ευχαριστούμε!",
          nextGoal: "event_score",
        }),
      );

      const first = await harness.extractor.extract({
        conversationId,
        correlationId,
      });
      const replay = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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
              sourceMessageIds: ["p1"],
              confidence: 0.9,
            },
          ],
          notes: [
            {
              noteType: "general",
              text: "Ωραία βραδιά.",
              subjectParticipantId: null,
              subjectMentionedName: null,
              sourceMessageIds: ["p1"],
              confidence: 0.6,
            },
          ],
          reply: "Ευχαριστούμε!",
          nextGoal: "event_score",
        }),
      );

      await harness.extractor.extract({ conversationId, correlationId });
      // The worker died before MongoDB learned the run had finished.
      harness.conversations.get(conversationId).extraction.cursorSeq = 0;

      const replay = await harness.extractor.extract({
        conversationId,
        correlationId,
      });

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

      await harness.extractor.extract({ conversationId, correlationId });

      expect(
        harness.conversations.goalStatuses(conversationId).event_score,
      ).toBe("answered");
    });
  });

  describe("observability", () => {
    it("logs both model phases per run rather than message count", async () => {
      await harness.extractor.extract({ conversationId, correlationId });

      expect(harness.metrics.totalTokensObserved()).toBe(1_130);
      expect(harness.metrics.countExtract("extracted")).toBe(1);
    });
  });

  it("does not retry a job whose conversation is gone", async () => {
    await expect(
      harness.extractor.extract({
        conversationId: randomUUID(),
        correlationId,
      }),
    ).rejects.toThrow(/was not found/u);
  });

  it("does not retry a job whose campaign is gone", async () => {
    harness.repository.campaigns.clear();

    await expect(
      harness.extractor.extract({ conversationId, correlationId }),
    ).rejects.toThrow(/campaign .* was not found/iu);
  });
});

interface FakeMessage {
  id: string;
  seq: number;
  actor: "bot" | "participant" | "staff" | "system";
  text: string;
  at: Date;
  outboxId?: string | null;
  attention?: {
    categories: string[];
    recommendedAction: string;
    confidence: number;
  } | null;
}

interface FakeGoal {
  key: "event_score" | "liked" | "meet_again" | "avoid";
  ordinal: number;
  prompt: string;
  status: "pending" | "asked" | "answered" | "skipped";
}

interface FakeConversation {
  _id: string;
  campaignId: string;
  respondentParticipantId: string;
  lifecycle: { state: string; reason: string | null; closedAt: Date | null };
  control: { mode: string; source: string; changedAt: Date };
  goals: FakeGoal[];
  messages: FakeMessage[];
  extraction: {
    cursorSeq: number;
    lastRunAt: Date | null;
    model: string | null;
    usage?: FeedbackConversationExtractionUsage | null;
    serviceTier?: string | null;
  };
  needsAttention: boolean;
  attentionReasons: {
    id: string;
    kind: string;
    messageId: string | null;
    resolvedAt: Date | null;
  }[];
  awaitingHuman: boolean;
  reminderCount: number;
  extractionFallbackAckSent?: boolean;
}

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

  async findCampaignById(id: string) {
    return this.campaigns.get(id);
  }

  async listAnswersByConversation(id: string) {
    return this.answers.filter((row) => row.conversationId === id);
  }

  async listNotesByConversation(id: string) {
    return this.notes.filter((row) => row.conversationId === id);
  }

  lockConversation(): Promise<unknown> {
    this.locked += 1;
    return Promise.resolve();
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

class FakeConversations {
  readonly documents = new Map<string, FakeConversation>();

  seed(conversation: FakeConversation): void {
    this.documents.set(conversation._id, conversation);
  }

  get(id: string): FakeConversation {
    const conversation = this.documents.get(id);
    if (!conversation) {
      throw new Error(`Conversation ${id} was not seeded`);
    }
    return conversation;
  }

  goalStatuses(id: string): Record<string, string> {
    return Object.fromEntries(
      this.get(id).goals.map((goal) => [goal.key, goal.status]),
    );
  }

  setAllGoals(id: string, status: FakeGoal["status"]): void {
    for (const goal of this.get(id).goals) {
      goal.status = status;
    }
  }

  setGoal(id: string, key: string, status: FakeGoal["status"]): void {
    const goal = this.get(id).goals.find((entry) => entry.key === key);
    if (goal) {
      goal.status = status;
    }
  }

  async findById(id: string): Promise<FakeConversation | undefined> {
    const conversation = this.documents.get(id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  /** Idempotent by `outboxId`, like the real repository. */
  async appendMessage(input: {
    conversationId: string;
    actor: FakeMessage["actor"];
    text: string;
    at: Date;
    outboxId?: string | null;
  }): Promise<{
    appended: boolean;
    message: FakeMessage;
    conversation: FakeConversation;
  }> {
    const conversation = this.get(input.conversationId);
    const existing = conversation.messages.find(
      (message) => input.outboxId && message.outboxId === input.outboxId,
    );
    if (existing) {
      return { appended: false, message: existing, conversation };
    }
    const message: FakeMessage = {
      id: randomUUID(),
      seq: conversation.messages.length + 1,
      actor: input.actor,
      text: input.text.trim(),
      at: input.at,
      outboxId: input.outboxId ?? null,
    };
    conversation.messages.push(message);
    return { appended: true, message, conversation };
  }

  /**
   * Rank-up along pending < asked < skipped < answered, plus WP-9δ
   * skipped → asked. Mirrors `canTransitionGoalStatus`.
   */
  async updateGoalStatuses(input: {
    conversationId: string;
    statuses: readonly { key: string; status: FakeGoal["status"] }[];
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const rank = { pending: 0, asked: 1, skipped: 2, answered: 3 } as const;
    const conversation = this.get(input.conversationId);
    let changed = false;
    for (const entry of input.statuses) {
      const goal = conversation.goals.find((item) => item.key === entry.key);
      if (!goal || goal.status === entry.status) {
        continue;
      }
      const reopensSkip = goal.status === "skipped" && entry.status === "asked";
      const ranksUp = rank[entry.status] > rank[goal.status];
      if (reopensSkip || ranksUp) {
        goal.status = entry.status;
        changed = true;
      }
    }
    return { changed, conversation };
  }

  async advanceCursor(input: {
    conversationId: string;
    toSeq: number;
    at: Date;
    model?: string | null;
    serviceTier?: string | null;
    usage?: FeedbackConversationExtractionUsage;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    if (input.toSeq <= conversation.extraction.cursorSeq) {
      return { changed: false, conversation };
    }
    conversation.extraction = {
      cursorSeq: input.toSeq,
      lastRunAt: input.at,
      model: input.model ?? null,
      // Accumulated by the shared rule, so a case here cannot pass on a total
      // the database would never produce. An absent usage is a run that called
      // no model, and it leaves the earlier runs' tokens alone.
      usage: input.usage
        ? accumulateFeedbackExtractionUsage(
            conversation.extraction.usage ?? null,
            input.usage,
          )
        : (conversation.extraction.usage ?? null),
      serviceTier: input.serviceTier ?? null,
    };
    return { changed: true, conversation };
  }

  /** Idempotent on kind + message, exactly as the Mongo guard filter is. */
  async raiseAttention(input: {
    conversationId: string;
    kind: string;
    messageId: string | null;
    at: Date;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const standing = conversation.attentionReasons.some(
      (reason) =>
        reason.kind === input.kind &&
        reason.messageId === input.messageId &&
        reason.resolvedAt === null,
    );
    if (standing) {
      return { changed: false, conversation };
    }
    conversation.attentionReasons.push({
      id: randomUUID(),
      kind: input.kind,
      messageId: input.messageId,
      resolvedAt: null,
    });
    conversation.needsAttention = true;
    return { changed: true, conversation };
  }

  async markAwaitingHuman(input: {
    conversationId: string;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const changed = conversation.awaitingHuman !== true;
    conversation.awaitingHuman = true;
    return { changed, conversation };
  }

  async mergeMessageAttention(input: {
    conversationId: string;
    messageId: string;
    categories: readonly string[];
    recommendedAction: string;
    confidence: number;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const message = conversation.messages.find(
      (candidate) => candidate.id === input.messageId,
    );
    if (!message) {
      throw new Error(`Message ${input.messageId} not found`);
    }
    message.attention = {
      categories: [
        ...new Set([
          ...(message.attention?.categories ?? []),
          ...input.categories,
        ]),
      ],
      recommendedAction: input.recommendedAction,
      confidence: Math.max(
        message.attention?.confidence ?? 0,
        input.confidence,
      ),
    };
    return { changed: true, conversation };
  }

  async close(input: {
    conversationId: string;
    reason: string;
    at: Date;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    if (conversation.lifecycle.state === "closed") {
      return { changed: false, conversation };
    }
    conversation.lifecycle = {
      state: "closed",
      reason: input.reason,
      closedAt: input.at,
    };
    return { changed: true, conversation };
  }
}

interface Harness {
  extractor: PostEventFeedbackExtractor;
  repository: FakeFeedbackRepository;
  conversations: FakeConversations;
  participants: FakeParticipants;
  events: { listFeedbackCandidatesForRespondent: ReturnType<typeof vi.fn> };
  generation: {
    serviceTier: string | undefined;
    propose: ReturnType<typeof vi.fn>;
    classifyAttention: ReturnType<typeof vi.fn>;
  };
  audit: FakeAudit;
  metrics: PostEventFeedbackMetrics;
  alert: { raised: FeedbackOperatorAlertInput[] };
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
  const conversations = new FakeConversations();
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
  };
  const generationService = {
    // Mutable so a case can put the model on OpenAI's fast lane, which is the
    // only thing that makes the persisted tier anything but null.
    serviceTier: undefined as string | undefined,
    propose: vi.fn().mockResolvedValue(generation({})),
    classifyAttention: vi.fn().mockResolvedValue(attentionGeneration([])),
  };
  const alert = {
    raised: [] as FeedbackOperatorAlertInput[],
    async raise(input: FeedbackOperatorAlertInput): Promise<void> {
      this.raised.push(input);
    },
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
  conversations.seed({
    _id: conversationId,
    campaignId,
    respondentParticipantId: respondentId,
    lifecycle: { state: "open", reason: null, closedAt: null },
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
      {
        id: "b1",
        seq: 1,
        actor: "bot",
        text: "Πώς σου φάνηκε η βραδιά;",
        at: new Date("2026-07-25T10:01:00.000Z"),
      },
      {
        id: "p1",
        seq: 2,
        actor: "participant",
        text: "5! Ο Νίκος ήταν φοβερός. Η βραδιά κύλησε γρήγορα.",
        at: new Date("2026-07-25T10:02:00.000Z"),
      },
    ],
    extraction: {
      cursorSeq: 0,
      lastRunAt: null,
      model: null,
      usage: null,
      serviceTier: null,
    },
    needsAttention: false,
    attentionReasons: [],
    awaitingHuman: false,
    reminderCount: 0,
    extractionFallbackAckSent: false,
  });

  const database = new FakeDatabase();
  const extractor = new PostEventFeedbackExtractor(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackCampaignRepository,
    repository as unknown as FeedbackResultsRepository,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsService,
    participants as unknown as ParticipantsRepository,
    generationService as unknown as PostEventFeedbackExtractionModel,
    audit as unknown as AuditRepository,
    metrics,
    new FeedbackOutboundTranscriptService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
    ),
    new FeedbackOutboundLogService(
      repository as unknown as FeedbackOutboundLogRepository,
    ),
    alert,
  );

  return {
    extractor,
    repository,
    conversations,
    participants,
    events,
    generation: generationService,
    audit,
    metrics,
    alert,
  };
}
