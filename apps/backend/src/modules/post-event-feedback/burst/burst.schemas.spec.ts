import { describe, expect, it } from "vitest";

import { FEEDBACK_OBSERVED_TEXT_HARD_LIMIT } from "../jobs.schemas.js";
import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../post-event-feedback-conversation.document.js";
import { BURST_PERSONAS } from "./burst-personas.js";
import {
  BURST_CAMPAIGNS,
  BURST_PERSONAS_PER_CAMPAIGN,
  burstPersonaCatalogEntry,
  burstPersonaPhoneE164,
} from "./burst-scenario.js";
import { feedbackBurstCatalogResponseSchema } from "./burst.schemas.js";

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

describe("BURST_PERSONAS", () => {
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
    const QUIET_WINDOW_MS = 45_000;

    for (const persona of BURST_PERSONAS) {
      const clusters = persona.messages.filter(
        (message, index) => index === 0 || message.afterMs > QUIET_WINDOW_MS,
      ).length;

      expect(
        persona.stub.length,
        `${persona.id} sends ${clusters} clusters but declares ${persona.stub.length} stub turns`,
      ).toBeLessThanOrEqual(clusters);
    }
  });
});
