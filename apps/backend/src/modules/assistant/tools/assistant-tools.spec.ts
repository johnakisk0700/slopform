import { describe, expect, it, vi } from "vitest";

import { AssistantToolsService } from "./assistant-tools.service.js";

/**
 * The real registry over doubles, named by role rather than by position.
 *
 * Five positional constructor arguments is exactly the shape that starts
 * silently swapping two services of the same type, and every test here cares
 * about at most one of them.
 */
function createTools(
  doubles: {
    events?: Record<string, unknown>;
    participants?: Record<string, unknown>;
    campaigns?: Record<string, unknown>;
    conversations?: Record<string, unknown>;
    summaries?: Record<string, unknown>;
  } = {},
): AssistantToolsService {
  return new AssistantToolsService(
    (doubles.events ?? { list: vi.fn(), get: vi.fn() }) as never,
    (doubles.participants ?? {
      list: vi.fn(),
      get: vi.fn(),
      listEvents: vi.fn(),
    }) as never,
    (doubles.campaigns ?? { list: vi.fn(), get: vi.fn() }) as never,
    (doubles.conversations ?? {
      listForCampaign: vi.fn(),
      get: vi.fn(),
      listConversationResults: vi.fn(),
    }) as never,
    (doubles.summaries ?? { get: vi.fn() }) as never,
  );
}

describe("assistant tool execution", () => {
  it("caps a large result set and says that it did", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      preferredName: `Person ${index}`,
      emailNormalized: `person${index}@example.com`,
      phoneE164: null,
      ageBand: null,
      preferredNeighborhood: null,
      conversationStyle: null,
      postEventFeedbackWhatsappOptIn: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const service = createTools({
      participants: {
        list: vi.fn().mockResolvedValue({ items }),
        get: vi.fn(),
        listEvents: vi.fn(),
      },
    });

    const execute = service.toolSet().search_participants?.execute;
    const result = (await execute?.({}, {
      toolCallId: "call-1",
      messages: [],
    } as never)) as {
      rows: readonly unknown[];
      total: number;
      truncated: boolean;
    };

    expect(result.rows).toHaveLength(25);
    expect(result.total).toBe(40);
    expect(result.truncated).toBe(true);
  });

  /**
   * A clipped transcript must keep the end, and a resolved flag must not be
   * reported as live. Both are the kind of quiet wrongness a model states
   * confidently: the first drops the disclosure and keeps the greeting, the
   * second tells an operator to go and look at something already dealt with.
   */
  it("keeps the tail of a long transcript and only live attention reasons", async () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      actor: index % 2 === 0 ? "bot" : "participant",
      text: `message ${index}`,
      at: "2026-08-01T10:00:00.000Z",
    }));
    const service = createTools({
      conversations: {
        listForCampaign: vi.fn(),
        get: vi.fn().mockResolvedValue({
          id: "c1",
          campaignId: "k1",
          respondentDisplayName: "Maria",
          respondentParticipantId: "p1",
          phoneAtLaunch: "+306900000000",
          lifecycle: { state: "open", reason: null },
          control: { mode: "bot" },
          needsAttention: true,
          attentionReasons: [
            { kind: "safety_disclosure", resolvedAt: null },
            {
              kind: "explicit_request",
              resolvedAt: "2026-08-01T11:00:00.000Z",
            },
          ],
          goals: [],
          messages,
        }),
        listConversationResults: vi
          .fn()
          .mockResolvedValue({ answers: [], notes: [] }),
      },
    });

    const execute = service.toolSet().get_feedback_conversation?.execute;
    const result = (await execute?.(
      { campaignId: "k1", conversationId: "c1" },
      { toolCallId: "call-1", messages: [] } as never,
    )) as {
      messages: { text: string }[];
      messagesTruncated: boolean;
      messageCount: number;
      attentionReasons: string[];
    };

    expect(result.messages).toHaveLength(25);
    expect(result.messages.at(-1)?.text).toBe("message 39");
    expect(result.messagesTruncated).toBe(true);
    expect(result.messageCount).toBe(40);
    expect(result.attentionReasons).toEqual(["safety_disclosure"]);
  });

  it("answers a missing id instead of failing the turn", async () => {
    const { EventNotFoundError } =
      await import("../../events/events.service.js");
    const service = createTools({
      events: {
        list: vi.fn(),
        get: vi.fn().mockRejectedValue(new EventNotFoundError("missing")),
      },
    });

    const execute = service.toolSet().get_event?.execute;
    await expect(
      execute?.({ eventId: "11111111-1111-4111-8111-111111111111" }, {
        toolCallId: "call-1",
        messages: [],
      } as never),
    ).resolves.toMatchObject({ found: false, entity: "event" });
  });
});
