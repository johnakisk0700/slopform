import { describe, expect, it, vi } from "vitest";
import { asSchema } from "ai";

import { AssistantToolsService } from "./assistant-tools.service.js";

interface JsonSchemaNode {
  readonly type?: string | string[];
  readonly description?: string;
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly items?: JsonSchemaNode;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly allOf?: readonly JsonSchemaNode[];
  readonly $ref?: string;
  readonly additionalProperties?: boolean | JsonSchemaNode;
}

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

function registry(): AssistantToolsService {
  return createTools();
}

async function inputSchemaOf(name: string): Promise<JsonSchemaNode> {
  const definition = registry().toolSet()[name];
  if (!definition?.inputSchema) {
    throw new Error(`Tool ${name} has no input schema`);
  }
  const { jsonSchema } = await asSchema(definition.inputSchema);
  return jsonSchema as JsonSchemaNode;
}

describe("assistant tool registry", () => {
  it("describes every tool it offers", () => {
    for (const [name, definition] of Object.entries(registry().toolSet())) {
      expect(definition.description, `${name} needs a description`).toBeTypeOf(
        "string",
      );
      expect(definition.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  /**
   * The narrowest provider decides the schema, not the SDK.
   *
   * A union or a nested object is accepted by OpenAI direct and rejected
   * mid-turn by another route, which surfaces as an unexplained provider
   * rejection on one model only — the most expensive kind of bug to chase. The
   * cost of keeping inputs flat is a wordier tool; the cost of not is a model
   * that works in review and fails for whoever picked Gemini.
   */
  it("keeps every input schema inside the portable subset", async () => {
    for (const name of Object.keys(registry().toolSet())) {
      const schema = await inputSchemaOf(name);
      expect(schema.type, `${name} must take an object`).toBe("object");

      for (const [field, property] of Object.entries(schema.properties ?? {})) {
        const where = `${name}.${field}`;
        expect(property.$ref, `${where} must not use $ref`).toBeUndefined();
        expect(property.anyOf, `${where} must not use anyOf`).toBeUndefined();
        expect(property.oneOf, `${where} must not use oneOf`).toBeUndefined();
        expect(property.allOf, `${where} must not use allOf`).toBeUndefined();
        expect(
          property.properties,
          `${where} must not nest an object`,
        ).toBeUndefined();
        expect(property.description, `${where} needs a description`).toBeTypeOf(
          "string",
        );
      }
    }
  });

  it("names its tools in the vocabulary the system prompt teaches", () => {
    expect(Object.keys(registry().toolSet())).toEqual([
      "current_datetime",
      "list_events",
      "get_event",
      "search_participants",
      "get_participant",
      "list_feedback_campaigns",
      "get_campaign_summary",
      "list_feedback_conversations",
      "get_feedback_conversation",
    ]);
  });
});

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
