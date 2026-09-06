import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FeedbackConversationTransitionError } from "./post-event-feedback-conversation.errors.js";
import {
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
} from "./post-event-feedback-conversation.document.js";
import {
  admitsAwaitingHumanWorkFence,
  admitsExactWorkFence,
  applyAdvanceCursor,
  applyAdvanceCursorAndClose,
  applyAdvanceCursorAndMarkAwaitingHuman,
  applyAppendMessage,
  applyClose,
  applyMarkAwaitingHuman,
  applyMarkReminded,
  applyMarkWorkDue,
  applyMergeMessageAttention,
  applyParkExtraction,
  applyRaiseAttention,
  applyRecordHostileTurn,
  applyReconcileStoppedWithoutAnswers,
  applyResolveAttentionReason,
  applyResumeBot,
  applySettleWorkExecution,
  applyTakeOver,
  applyUpdateGoalStatuses,
} from "./post-event-feedback-conversation.state.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = deriveFeedbackConversationId(
  campaignId,
  respondentParticipantId,
);
const phoneAtLaunch = "+306900000000";
const launchedAt = new Date("2026-07-25T10:00:00.000Z");
const repliedAt = new Date("2026-07-25T10:05:00.000Z");
const outboxId = "d4a4b3c2-8f1e-4d3c-9b2a-1e0f9d8c7b6a";
const messageId = "5c7e6f10-3a2b-4c1d-8e9f-0a1b2c3d4e5f";
const reasonId = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

describe("feedback conversation domain transitions", () => {
  it("marks durable work due by advancing its revision", () => {
    const nextActionAt = new Date("2026-07-25T10:06:00.000Z");
    const updated = applyMarkWorkDue(
      conversation({
        work: { revision: 3, nextActionAt: null, executionEpoch: 2 },
      }),
      nextActionAt,
      repliedAt,
    );
    expect(updated.work).toMatchObject({
      revision: 4,
      nextActionAt,
      executionEpoch: 2,
    });
  });

  it("settles its snapshot without erasing a newer revision's rolling schedule", () => {
    const newerDue = new Date("2026-07-25T10:07:00.000Z");
    const current = conversation({
      work: { revision: 6, nextActionAt: newerDue, executionEpoch: 11 },
    });
    expect(
      applySettleWorkExecution(current, {
        revision: 5,
        nextActionAt: null,
        at: repliedAt,
      }),
    ).toMatchObject({
      changed: false,
      conversation: {
        work: { revision: 6, nextActionAt: newerDue, executionEpoch: 11 },
      },
    });
  });

  it("advances the revision when settlement schedules a successor wake-up", () => {
    const nextActionAt = new Date("2026-07-25T10:07:00.000Z");
    const result = applySettleWorkExecution(
      conversation({
        work: { revision: 5, nextActionAt: repliedAt, executionEpoch: 11 },
      }),
      { revision: 5, nextActionAt, at: repliedAt },
    );
    expect(result).toMatchObject({
      changed: true,
      conversation: { work: { revision: 6, nextActionAt } },
    });
  });

  it("clears due work without advancing its revision when awaiting human", () => {
    const result = applyMarkAwaitingHuman(
      conversation({
        work: { revision: 4, nextActionAt: repliedAt, executionEpoch: 1 },
      }),
      repliedAt,
    );
    expect(result.changed).toBe(true);
    expect(result.conversation.awaitingHuman).toBe(true);
    expect(result.conversation.work).toMatchObject({
      revision: 4,
      nextActionAt: null,
    });
  });

  it("takes over from bot control and records the control source", () => {
    const result = applyTakeOver(conversation(), {
      source: "staff_action",
      at: repliedAt,
    });
    expect(result.conversation.control).toEqual({
      mode: "human",
      source: "staff_action",
      changedAt: repliedAt,
    });
    expect(result.conversation.awaitingHuman).toBe(false);
  });

  it("never resumes bot control on a closed conversation", () => {
    expect(() =>
      applyResumeBot(
        conversation({
          lifecycle: {
            state: "closed",
            reason: "stopped",
            closedAt: repliedAt,
          },
          control: {
            mode: "human",
            source: "staff_action",
            changedAt: repliedAt,
          },
        }),
        repliedAt,
      ),
    ).toThrow(FeedbackConversationTransitionError);
  });

  it("resumes control and creates unread work in one generation", () => {
    const result = applyResumeBot(
      conversation({
        control: {
          mode: "human",
          source: "staff_action",
          changedAt: launchedAt,
        },
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction({ cursorSeq: 1 }),
        work: { revision: 7, nextActionAt: null, executionEpoch: 4 },
      }),
      repliedAt,
    );
    expect(result.conversation.control).toMatchObject({
      mode: "bot",
      source: "staff_action",
    });
    expect(result.conversation.work).toMatchObject({
      revision: 8,
      nextActionAt: repliedAt,
    });
  });

  it("lets STOP override a softer terminal reason but never the reverse", () => {
    const stopped = applyClose(conversation(), {
      reason: "stopped",
      at: repliedAt,
      terminalOutboxId: outboxId,
      staffClose: null,
    });
    expect(stopped.conversation.lifecycle).toMatchObject({
      state: "closed",
      reason: "stopped",
      terminalOutboxId: outboxId,
    });
    expect(stopped.conversation.staffClose).toBeNull();

    const reverse = applyClose(stopped.conversation, {
      reason: "completed",
      at: repliedAt,
      terminalOutboxId: null,
      staffClose: null,
    });
    expect(reverse.changed).toBe(false);
    expect(reverse.conversation.lifecycle.reason).toBe("stopped");
  });

  it("lowers the badge on close when no reason is holding it up", () => {
    const result = applyClose(conversation({ needsAttention: true }), {
      reason: "cancelled",
      at: repliedAt,
      terminalOutboxId: null,
      staffClose: null,
    });
    expect(result.conversation.needsAttention).toBe(false);
  });

  it("never auto-resolves a standing reason just because the thread closed", () => {
    const result = applyClose(
      conversation({
        needsAttention: true,
        attentionReasons: [attentionReason({ kind: "handoff" })],
      }),
      {
        reason: "cancelled",
        at: repliedAt,
        terminalOutboxId: null,
        staffClose: null,
      },
    );
    expect(result.conversation.needsAttention).toBe(true);
    expect(result.conversation.attentionReasons[0]?.resolvedAt).toBeNull();
  });

  it("clears a staff close label when STOP overrides", () => {
    const cancelled = applyClose(conversation(), {
      reason: "cancelled",
      at: launchedAt,
      terminalOutboxId: null,
      staffClose: { reason: "abusive", note: "note" },
    });
    const stopped = applyClose(cancelled.conversation, {
      reason: "stopped",
      at: repliedAt,
      terminalOutboxId: outboxId,
      staffClose: null,
    });
    expect(stopped.changed).toBe(true);
    expect(stopped.conversation.staffClose).toBeNull();
    expect(stopped.conversation.lifecycle.reason).toBe("stopped");
  });

  it("adds a reported usage component and leaves an absent usage untouched", () => {
    const seeded = conversation({
      messages: [botMessage(1), participantMessage(2)],
      extraction: emptyExtraction({
        usage: { inputTokens: 1_200, outputTokens: 200, totalTokens: 1_400 },
      }),
    });
    const added = applyAdvanceCursor(seeded, {
      toSeq: 2,
      at: repliedAt,
      model: "google/gemini-3.6-flash",
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
    });
    expect(added.conversation.extraction.usage).toEqual({
      inputTokens: 1_500,
      outputTokens: 280,
      totalTokens: 1_780,
    });

    const skipped = applyAdvanceCursor(
      conversation({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction({
          cursorSeq: 0,
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        }),
      }),
      { toSeq: 2, at: repliedAt, model: "google/gemini-3.6-flash" },
    );
    expect(skipped.conversation.extraction.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  });

  it("writes an unreported component as a literal null the sums can never leave", () => {
    const result = applyAdvanceCursor(
      conversation({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction({
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        }),
      }),
      {
        toSeq: 2,
        at: repliedAt,
        usage: { inputTokens: null, outputTokens: 1, totalTokens: 1 },
      },
    );
    expect(result.conversation.extraction.usage).toEqual({
      inputTokens: null,
      outputTokens: 3,
      totalTokens: 13,
    });
  });

  it("overwrites the service tier on every advancing run, including back to none", () => {
    const result = applyAdvanceCursor(
      conversation({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction({ serviceTier: "priority" }),
      }),
      { toSeq: 2, at: repliedAt, model: "m", serviceTier: null },
    );
    expect(result.conversation.extraction.serviceTier).toBeNull();
  });

  it("rejects a cursor that would pass the transcript", () => {
    expect(() =>
      applyAdvanceCursor(conversation({ messages: [botMessage(1)] }), {
        toSeq: 2,
        at: repliedAt,
      }),
    ).toThrow(FeedbackConversationTransitionError);
  });

  it("admits an unclaimed fence at epoch 0 without inventing a match for a missing row", () => {
    const current = conversation({
      messages: [botMessage(1), participantMessage(2)],
      work: { revision: 0, nextActionAt: null, executionEpoch: 0 },
    });
    expect(admitsExactWorkFence(current, { revision: 0, epoch: 0 }, 0)).toBe(
      true,
    );
    expect(
      admitsExactWorkFence(current, { revision: 0, epoch: 0 }, undefined),
    ).toBe(false);
  });

  it("does not match a paid cursor fence when the execution row is missing", () => {
    const current = conversation({
      messages: [botMessage(1), participantMessage(2)],
      work: { revision: 3, nextActionAt: repliedAt, executionEpoch: 0 },
    });
    expect(
      admitsExactWorkFence(current, { revision: 3, epoch: 8 }, undefined),
    ).toBe(false);
    expect(
      applyAdvanceCursor(current, {
        toSeq: 2,
        at: repliedAt,
        expectedWork: { revision: 3, epoch: 8 },
      }).changed,
    ).toBe(false);
  });

  it("admits a newer work revision only when the same execution has newer testimony", () => {
    const current = conversation({
      messages: [botMessage(1), participantMessage(2), participantMessage(3)],
      extraction: emptyExtraction({ cursorSeq: 2 }),
      work: { revision: 5, nextActionAt: repliedAt, executionEpoch: 8 },
    });
    expect(
      admitsAwaitingHumanWorkFence(current, { revision: 4, epoch: 8 }, 8, 2),
    ).toBe(true);
    expect(
      admitsAwaitingHumanWorkFence(
        conversation({
          messages: [botMessage(1), participantMessage(2)],
          work: { revision: 5, nextActionAt: repliedAt, executionEpoch: 8 },
        }),
        { revision: 4, epoch: 8 },
        8,
        2,
      ),
    ).toBe(false);
  });

  it("advances the snapshot cursor and closes only when no newer participant message exists", () => {
    const closable = applyAdvanceCursorAndClose(
      conversation({
        messages: [botMessage(1), participantMessage(2)],
        work: { revision: 3, nextActionAt: repliedAt, executionEpoch: 2 },
      }),
      {
        toSeq: 2,
        reason: "completed",
        terminalOutboxId: outboxId,
        at: repliedAt,
        model: "m",
        serviceTier: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        expectedWork: { revision: 3, epoch: 2 },
        fenceEpoch: 2,
      },
    );
    expect(closable.conversation.lifecycle.reason).toBe("completed");

    const superseded = applyAdvanceCursorAndClose(
      conversation({
        messages: [botMessage(1), participantMessage(2), participantMessage(3)],
      }),
      {
        toSeq: 2,
        reason: "completed",
        terminalOutboxId: outboxId,
        at: repliedAt,
        model: "m",
        serviceTier: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    );
    expect(superseded.changed).toBe(false);
    expect(superseded.conversation.lifecycle.state).toBe("open");
  });

  it("repairs an awaiting-human row whose cursor is already at the snapshot", () => {
    const result = applyAdvanceCursorAndMarkAwaitingHuman(
      conversation({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction({ cursorSeq: 2 }),
        work: { revision: 3, nextActionAt: repliedAt, executionEpoch: 4 },
      }),
      {
        toSeq: 2,
        at: repliedAt,
        model: "m",
        serviceTier: "priority",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        expectedWork: { revision: 3, epoch: 4 },
        fenceEpoch: 4,
      },
    );
    expect(result.changed).toBe(true);
    expect(result.conversation.awaitingHuman).toBe(true);
    expect(result.conversation.extraction.usage).toBeNull();
  });

  it("keeps the first park's start time while counting every parked run", () => {
    const first = applyParkExtraction(conversation(), launchedAt);
    const second = applyParkExtraction(first.conversation, repliedAt);
    expect(second.conversation.extraction.parkedSince).toEqual(launchedAt);
    expect(second.conversation.extraction.parkedRuns).toBe(2);
  });

  it("advances goal statuses and never reopens an answered goal", () => {
    const result = applyUpdateGoalStatuses(
      conversation({
        goals: [
          {
            key: "event_score",
            ordinal: 1,
            prompt: "score;",
            status: "answered",
          },
          { key: "liked", ordinal: 2, prompt: "liked;", status: "pending" },
          { key: "meet_again", ordinal: 3, prompt: "meet;", status: "pending" },
          { key: "avoid", ordinal: 4, prompt: "avoid;", status: "pending" },
        ],
      }),
      {
        statuses: [
          { key: "event_score", status: "asked" },
          { key: "liked", status: "asked" },
        ],
        at: repliedAt,
      },
    );
    expect(result.changed).toBe(true);
    expect(
      result.conversation.goals.find((goal) => goal.key === "event_score")
        ?.status,
    ).toBe("answered");
    expect(
      result.conversation.goals.find((goal) => goal.key === "liked")?.status,
    ).toBe("asked");
  });

  it("reopens a skipped goal to asked when the bot's hold question lands", () => {
    const result = applyUpdateGoalStatuses(
      conversation({
        goals: [
          {
            key: "event_score",
            ordinal: 1,
            prompt: "score;",
            status: "answered",
          },
          { key: "liked", ordinal: 2, prompt: "liked;", status: "answered" },
          {
            key: "meet_again",
            ordinal: 3,
            prompt: "meet;",
            status: "answered",
          },
          { key: "avoid", ordinal: 4, prompt: "avoid;", status: "skipped" },
        ],
      }),
      { statuses: [{ key: "avoid", status: "asked" }], at: repliedAt },
    );
    expect(
      result.conversation.goals.find((goal) => goal.key === "avoid")?.status,
    ).toBe("asked");
  });

  it("clears stopped-without-answers when an in-flight extraction records an answer", () => {
    const result = applyReconcileStoppedWithoutAnswers(
      conversation({
        lifecycle: {
          state: "closed",
          reason: "stopped",
          closedAt: repliedAt,
        },
        needsAttention: true,
        goals: [
          {
            key: "event_score",
            ordinal: 1,
            prompt: "score;",
            status: "answered",
          },
        ],
        attentionReasons: [
          attentionReason({ kind: "stopped_without_answers" }),
        ],
      }),
      repliedAt,
    );
    expect(result.changed).toBe(true);
    expect(result.conversation.attentionReasons[0]?.resolvedBy).toBe(
      "system:feedback_extraction",
    );
    expect(result.conversation.needsAttention).toBe(false);
  });

  it("raises the badge once per standing kind and message", () => {
    const first = applyRaiseAttention(conversation(), {
      kind: "safety",
      messageId,
      at: repliedAt,
    });
    const second = applyRaiseAttention(first.conversation, {
      kind: "safety",
      messageId,
      at: repliedAt,
    });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.conversation.needsAttention).toBe(true);
    expect(first.conversation.attentionReasons).toHaveLength(1);
  });

  it("lowers the badge when the reason resolved was the last one standing", () => {
    const flagged = applyRaiseAttention(conversation(), {
      kind: "safety",
      messageId,
      at: repliedAt,
    });
    const reason = flagged.conversation.attentionReasons[0];
    const resolved = applyResolveAttentionReason(flagged.conversation, {
      reasonId: reason!.id,
      resolvedBy: "admin-1",
      at: repliedAt,
    });
    expect(resolved.conversation.needsAttention).toBe(false);
  });

  it("counts a hostile turn only when the expected count still matches", () => {
    const first = applyRecordHostileTurn(conversation(), {
      expectedCount: 0,
      at: repliedAt,
    });
    const replay = applyRecordHostileTurn(first.conversation, {
      expectedCount: 0,
      at: repliedAt,
    });
    expect(first.conversation.hostileTurns).toBe(1);
    expect(replay.changed).toBe(false);
  });

  it("advances the reminder ladder only on the expected rung", () => {
    const first = applyMarkReminded(conversation(), {
      expectedCount: 0,
      at: repliedAt,
    });
    const replay = applyMarkReminded(first.conversation, {
      expectedCount: 0,
      at: repliedAt,
    });
    expect(first.conversation.reminderCount).toBe(1);
    expect(replay.changed).toBe(false);
  });

  it("merges attention metadata onto the cited participant message", () => {
    const result = applyMergeMessageAttention(
      conversation({
        messages: [
          {
            ...participantMessage(1),
            id: messageId,
            attention: {
              categories: ["harassment"],
              recommendedAction: "review",
              confidence: 0.2,
            },
          },
        ],
      }),
      {
        messageId,
        categories: ["violence_or_threat"],
        recommendedAction: "urgent_human_follow_up",
        confidence: 0.9,
        at: repliedAt,
      },
    );
    expect(result.conversation.messages[0]?.attention).toEqual({
      categories: ["harassment", "violence_or_threat"],
      recommendedAction: "urgent_human_follow_up",
      confidence: 0.9,
    });
  });

  it("sorts an appended transcript by observed time while seq stays arrival order", () => {
    const first = applyAppendMessage(conversation(), {
      ...participantMessage(1),
      at: repliedAt,
    });
    const earlier = new Date("2026-07-25T10:01:00.000Z");
    const second = applyAppendMessage(first, {
      ...participantMessage(2),
      at: earlier,
    });
    expect(second.messages.map((message) => message.seq)).toEqual([2, 1]);
    expect(second.messages[0]?.at).toEqual(earlier);
  });
});

function conversation(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: launchedAt },
    goals: buildFeedbackConversationGoals(),
    messages: [],
    extraction: emptyExtraction(),
    work: { revision: 0, nextActionAt: null, executionEpoch: 0 },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    createdAt: launchedAt,
    updatedAt: repliedAt,
    ...overrides,
  };
}

function emptyExtraction(
  overrides: Partial<FeedbackConversationDocument["extraction"]> = {},
): FeedbackConversationDocument["extraction"] {
  return {
    cursorSeq: 0,
    lastRunAt: null,
    model: null,
    usage: null,
    serviceTier: null,
    parkedSince: null,
    parkedRuns: 0,
    parkedNoticeSentAt: null,
    ...overrides,
  };
}

function attentionReason(
  overrides: Partial<
    FeedbackConversationDocument["attentionReasons"][number]
  > = {},
): FeedbackConversationDocument["attentionReasons"][number] {
  const resolvedAt = overrides.resolvedAt ?? null;
  return {
    id: reasonId,
    kind: "safety",
    messageId,
    at: repliedAt,
    resolvedBy: resolvedAt === null ? null : "admin-1",
    ...overrides,
    resolvedAt,
  };
}

function botMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "bot",
    text: "Πώς σου φάνηκε η βραδιά;",
    providerMessageId: null,
    ingressId: null,
    outboxId: seq === 1 ? outboxId : randomUUID(),
    attention: null,
    at: launchedAt,
  };
}

function participantMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "participant",
    text: "Πέρασα τέλεια!",
    providerMessageId: null,
    ingressId: randomUUID(),
    outboxId: null,
    attention: null,
    at: launchedAt,
  };
}
