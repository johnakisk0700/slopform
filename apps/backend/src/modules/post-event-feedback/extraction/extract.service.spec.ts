import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { EventsService } from "../../events/events.service.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackOperatorAlertInput } from "../operator-alert.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeParticipants,
} from "../post-event-feedback-doubles.harness.js";
import { PostEventFeedbackExtractor } from "./extract.service.js";
import type { PostEventFeedbackExtractionModel } from "./model.service.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "../question-set.js";
import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";
import {
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  feedbackExtractionGoalVerdicts,
  type FeedbackExtractionAnswerProposal,
} from "./extraction.schemas.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "./results.repository.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const eventId = "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10";
const respondentId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const nikos = "1b0a2f1c-2d3e-4f50-8a91-0b2c3d4e5f60";
const eleni = "2c1b3a2d-3e4f-5061-9b02-1c3d4e5f6071";
const correlationId = "correlation-1";
const model = "google/gemini-3.6-flash";

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
      typesDuringTheRun({ handoff: true, reply: "Ευχαριστούμε πολύ!" });

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
        body: "Λυπάμαι πολύ που το ακούω.",
        dedupeKey: `feedback-reply-${conversationId}-2`,
      });
      expect(harness.repository.notes).toHaveLength(1);
      expect(harness.conversations.get(conversationId).needsAttention).toBe(
        true,
      );
      expect(harness.alert.raised).toHaveLength(1);
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
        body: "Λυπάμαι που το ακούω, θες να μιλήσουμε;",
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
        generation({ handoff: true, reply: "Ας συνεχίσουμε." }),
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

    it("does not seize control; a takeover stays an explicit human action (D17)", async () => {
      harness.generation.propose.mockResolvedValue(
        generation({ handoff: true }),
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
  };
  needsAttention: boolean;
  awaitingHuman: boolean;
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
}

/** Mirrors the WP2 repository contract the extractor actually depends on. */
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
  readonly notes: FakeResultRow[] = [];
  readonly outbox: Record<string, unknown>[] = [];
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
        input.questionKeys.includes(row.questionKey)
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
    },
  ): Promise<FakeResultRow | undefined> {
    const subject = input.subjectParticipantId ?? null;
    const existing = this.answers.find(
      (row) =>
        row.conversationId === input.conversationId &&
        row.questionKey === input.questionKey &&
        row.subjectParticipantId === subject,
    );
    if (existing) {
      existing.valueInt = input.valueInt ?? null;
      existing.extractionMeta = input.extractionMeta;
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

  /** Monotonic along pending < asked < skipped < answered. */
  async updateGoalStatuses(input: {
    conversationId: string;
    statuses: readonly { key: string; status: FakeGoal["status"] }[];
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const rank = { pending: 0, asked: 1, skipped: 2, answered: 3 } as const;
    const conversation = this.get(input.conversationId);
    let changed = false;
    for (const entry of input.statuses) {
      const goal = conversation.goals.find((item) => item.key === entry.key);
      if (goal && rank[entry.status] > rank[goal.status]) {
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
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    if (input.toSeq <= conversation.extraction.cursorSeq) {
      return { changed: false, conversation };
    }
    conversation.extraction = {
      cursorSeq: input.toSeq,
      lastRunAt: input.at,
      model: input.model ?? null,
    };
    return { changed: true, conversation };
  }

  async setNeedsAttention(input: {
    conversationId: string;
    needsAttention: boolean;
  }): Promise<{ changed: boolean; conversation: FakeConversation }> {
    const conversation = this.get(input.conversationId);
    const changed = conversation.needsAttention !== input.needsAttention;
    conversation.needsAttention = input.needsAttention;
    return { changed, conversation };
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

function attentionGeneration(
  signals: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    model,
    usage: { inputTokens: 180, outputTokens: 40, totalTokens: 220 },
    estimatedPromptTokens: 200,
    signals,
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
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
    awaitingHuman: false,
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
