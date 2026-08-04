import { describe, expect, it } from "vitest";

import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_OBSERVED_TEXT_HARD_LIMIT,
} from "../jobs.schemas.js";
import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../post-event-feedback-conversation.document.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V2 } from "../question-set.js";
import { BURST_PERSONAS } from "./burst-personas.js";
import {
  BURST_CAMPAIGNS,
  BURST_PERSONAS_PER_CAMPAIGN,
  burstPersonaCatalogEntry,
  burstPersonaPhoneE164,
} from "./burst-scenario.js";
import {
  feedbackBurstAccountingQuerySchema,
  feedbackBurstAccountingResponseSchema,
  feedbackBurstCatalogResponseSchema,
} from "./burst.schemas.js";
import { resolveStubTurnIndex } from "./scripted-extraction-model.service.js";

/**
 * The catalogue this endpoint actually serves, parsed by the schema that
 * actually guards it.
 *
 * Every other test in this folder builds a catalogue of its own, so the real
 * one had never been through the response schema. A fourth dinner therefore
 * turned the endpoint into a 500 with a full green suite behind it — and since
 * the runner reads this endpoint first, the rehearsal simply refused to start.
 */
describe("feedbackBurstCatalogResponseSchema", () => {
  it("accepts the catalogue the controller builds from the real constants", () => {
    const response = {
      extractionStub: false,
      workerRegistered: true,
      campaigns: BURST_CAMPAIGNS.map((campaign) => ({
        slug: campaign.slug,
        ordinal: campaign.ordinal,
        title: campaign.title,
        venue: campaign.venue,
      })),
      // The endpoint's own mapping, not a copy of it — see
      // `burstPersonaCatalogEntry`.
      personas: BURST_PERSONAS.map(burstPersonaCatalogEntry),
    };

    expect(() =>
      feedbackBurstCatalogResponseSchema.parse(response),
    ).not.toThrow();
  });
});

describe("feedback burst accounting schemas", () => {
  it("normalizes one campaign id and accepts the durable usage projection", () => {
    const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    expect(feedbackBurstAccountingQuerySchema.parse({ campaignId })).toEqual({
      campaignId: [campaignId],
    });
    expect(
      feedbackBurstAccountingResponseSchema.parse([
        {
          conversationId: "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55",
          extraction: {
            model: "openai/gpt-5.6-luna",
            usage: {
              inputTokens: 1_200,
              outputTokens: 200,
              totalTokens: 1_400,
            },
            serviceTier: null,
          },
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects a missing or unbounded campaign scope", () => {
    expect(() => feedbackBurstAccountingQuerySchema.parse({})).toThrow();
    expect(() =>
      feedbackBurstAccountingQuerySchema.parse({
        campaignId: Array.from(
          { length: BURST_CAMPAIGNS.length + 1 },
          () => "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        ),
      }),
    ).toThrow();
  });
});

describe("BURST_PERSONAS", () => {
  it("keeps every scripted rehearsal on V2 and completes every V2 finisher", () => {
    const v2Keys = POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions.map(
      (question) => question.key,
    );
    const allowed: ReadonlySet<string> = new Set(v2Keys);
    const newNumeric: ReadonlySet<string> = new Set([
      "table_fit",
      "participation_ease",
      "conversation_balance",
    ]);

    for (const persona of BURST_PERSONAS.filter((entry) => !entry.live)) {
      const terminal = new Set<string>();
      for (const turn of persona.stub) {
        for (const answer of turn.answers ?? []) {
          expect(
            allowed.has(answer.question),
            `${persona.id} scripts removed/non-V2 goal ${answer.question}`,
          ).toBe(true);
          terminal.add(answer.question);
          if (newNumeric.has(answer.question)) {
            expect(
              answer.value,
              `${persona.id} omits ${answer.question}`,
            ).toBeGreaterThanOrEqual(1);
            expect(
              answer.value,
              `${persona.id} exceeds ${answer.question}`,
            ).toBeLessThanOrEqual(5);
            expect(answer.about).toBeUndefined();
          }
        }
        for (const question of turn.skippedGoals ?? []) {
          expect(
            allowed.has(question),
            `${persona.id} skips removed/non-V2 goal ${question}`,
          ).toBe(true);
          terminal.add(question);
        }
        if (turn.nextGoal !== undefined && turn.nextGoal !== null) {
          expect(
            allowed.has(turn.nextGoal),
            `${persona.id} advances to removed/non-V2 goal ${turn.nextGoal}`,
          ).toBe(true);
        }
      }

      const expectedIdentities = persona.expect.answers.map((answer) => {
        expect(
          allowed.has(answer.question),
          `${persona.id} expects removed/non-V2 goal ${answer.question}`,
        ).toBe(true);
        if (newNumeric.has(answer.question)) {
          expect(answer.about).toBeNull();
          expect(answer.value).toBeGreaterThanOrEqual(1);
          expect(answer.value).toBeLessThanOrEqual(5);
        }
        return `${answer.question}:${answer.about ?? ""}`;
      });
      expect(
        new Set(expectedIdentities).size,
        `${persona.id} expects the same answer edge more than once`,
      ).toBe(expectedIdentities.length);

      if (persona.expect.closedBecause === "completed") {
        expect(
          [...terminal].filter((key) => allowed.has(key)).sort(),
          `${persona.id} completes without settling every V2 goal`,
        ).toEqual([...v2Keys].sort());
      }
    }
  });

  it("gives every persona a unique id and a unique phone", () => {
    const ids = BURST_PERSONAS.map((persona) => persona.id);
    const phones = BURST_PERSONAS.map(burstPersonaPhoneE164);

    expect(new Set(ids).size).toBe(ids.length);
    // Two personas on one number would collide on the partial unique index that
    // allows one open conversation per phone, and the second would silently
    // never be seeded.
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("seats every campaign with contiguous ordinals from one", () => {
    for (const campaign of BURST_CAMPAIGNS) {
      const ordinals = BURST_PERSONAS.filter(
        (persona) => persona.campaign === campaign.slug,
      )
        .map((persona) => persona.ordinal)
        .sort((left, right) => left - right);

      // A gap is a missing seat, and the seating is the input the extraction is
      // measured on: every persona's candidate list is whoever else sat down.
      // So the assertion is contiguity from one, at a full table, everywhere —
      // the live-guest dinner included, now that it seats six like the rest.
      expect(ordinals).toEqual(
        Array.from(
          { length: BURST_PERSONAS_PER_CAMPAIGN },
          (_, index) => index + 1,
        ),
      );
    }
  });

  it("keeps every message on one line", () => {
    // The extraction prompt renders one transcript message per line, and the
    // scripted model recovers messages by parsing those lines. A newline inside
    // a message ends the block early, so the persona simply stops being
    // findable — and the failure arrives as "matched no BURST_PERSONAS entry"
    // mid-rehearsal rather than here.
    for (const persona of BURST_PERSONAS) {
      for (const message of persona.messages) {
        expect(
          message.text ?? "",
          `${persona.id} sends a multi-line message`,
        ).not.toContain("\n");
      }
    }
  });

  it("drives one message past the send limit and none past the stored limit", () => {
    // The two bounds are different constraints and conflating them cost real
    // testimony (S31): 4 096 is what WhatsApp lets us *send*, 64 000 is what a
    // transcript entry may *hold*. A corpus entirely under the send limit never
    // exercises the gap, so at least one persona must sit inside it.
    const lengths = BURST_PERSONAS.flatMap((persona) =>
      persona.messages.map((message) => message.text?.length ?? 0),
    );

    expect(Math.max(...lengths)).toBeGreaterThan(
      FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
    );
    expect(Math.max(...lengths)).toBeLessThanOrEqual(
      FEEDBACK_OBSERVED_TEXT_HARD_LIMIT,
    );
  });

  it("declares one stub turn per extraction run its script causes", () => {
    // Clusters are separated by a gap past the quiet window; anything closer
    // collapses into the run before it. Running out of turns mid-rehearsal is a
    // loud failure by design, but it costs a paid run to discover.
    for (const persona of BURST_PERSONAS) {
      const clusters = persona.messages.filter(
        (message, index) =>
          index === 0 || message.afterMs > FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
      ).length;

      expect(
        persona.stub.length,
        `${persona.id} sends ${clusters} clusters but declares ${persona.stub.length} stub turns`,
      ).toBeLessThanOrEqual(clusters);
    }
  });

  it("resolves every declared stub turn from its message cluster alone", () => {
    // Two real worker processes share no model memory. Every turn must therefore
    // be recoverable from the prompt that either worker can receive, not from a
    // process-local cursor advanced by whichever worker happened to run first.
    for (const persona of BURST_PERSONAS) {
      const clusters: string[][] = [];
      for (const [index, message] of persona.messages.entries()) {
        if (index === 0 || message.afterMs > FEEDBACK_EXTRACT_QUIET_WINDOW_MS) {
          clusters.push([]);
        }
        if (message.text !== null) {
          clusters.at(-1)!.push(message.text);
        }
      }

      const textClusters = clusters.filter((cluster) => cluster.length > 0);
      for (const [turnIndex, cluster] of textClusters
        .slice(0, persona.stub.length)
        .entries()) {
        expect(
          resolveStubTurnIndex(persona, cluster),
          `${persona.id} turn ${turnIndex + 1}`,
        ).toBe(turnIndex);
      }
    }
  });
});

describe("BURST_CAMPAIGNS", () => {
  it("pins one distinct Google venue with feedback enabled per event", () => {
    const placeIds = BURST_CAMPAIGNS.map((campaign) => {
      expect(campaign.venue.provider, campaign.slug).toBe("google");
      expect(campaign.venue.placeId.trim(), campaign.slug).not.toBe("");
      expect(campaign.venue.useInFeedback, campaign.slug).toBe(true);
      return campaign.venue.placeId;
    });

    expect(new Set(placeIds).size).toBe(BURST_CAMPAIGNS.length);
  });
});
