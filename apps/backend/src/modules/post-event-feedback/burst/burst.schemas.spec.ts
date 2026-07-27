import { describe, expect, it } from "vitest";

import { BURST_PERSONAS } from "./burst-personas.js";
import {
  BURST_CAMPAIGNS,
  BURST_PERSONAS_PER_CAMPAIGN,
  burstPersonaDisplayName,
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
      personas: BURST_PERSONAS.map((persona) => ({
        id: persona.id,
        campaign: persona.campaign,
        ordinal: persona.ordinal,
        displayName: burstPersonaDisplayName(persona),
        phoneE164: burstPersonaPhoneE164(persona),
        quirk: persona.quirk,
        mirrors: persona.mirrors,
        messages: persona.messages.map((message) => ({
          afterMs: message.afterMs,
          text: message.text,
        })),
        expect: persona.expect,
      })),
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

      // A gap is a missing seat, and a table that is not a Six changes every
      // remaining persona's candidate list — which is the input the extraction
      // is measured on.
      expect(ordinals).toEqual(
        Array.from({ length: BURST_PERSONAS_PER_CAMPAIGN }, (_, i) => i + 1),
      );
    }
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
