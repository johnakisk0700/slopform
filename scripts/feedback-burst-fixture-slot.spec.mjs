import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertFeedbackBurstFixtureSlotMode,
  feedbackBurstFailedJobBelongsToSlot,
  feedbackBurstParticipantSeedEmail,
  namespaceFeedbackBurstCatalog,
  resolveFeedbackBurstFixtureSlot,
} from "./feedback-burst-fixture-slot.mjs";

describe("feedback burst fixture slot", () => {
  it("defaults to historical slot 0 and accepts one explicit digit", () => {
    assert.equal(resolveFeedbackBurstFixtureSlot(undefined), 0);
    assert.equal(resolveFeedbackBurstFixtureSlot("0"), 0);
    assert.equal(resolveFeedbackBurstFixtureSlot("1"), 1);
    assert.equal(resolveFeedbackBurstFixtureSlot(9), 9);
  });

  it("rejects ambiguous or out-of-range slot values", () => {
    for (const value of ["", "01", "10", "-1", "1.0", " 1", null]) {
      assert.throws(
        () => resolveFeedbackBurstFixtureSlot(value),
        /one digit from 0 through 9/u,
      );
    }
  });

  it("keeps slot 0 seed identities byte-for-byte compatible", () => {
    const source = fixtureCatalog();
    const slotted = namespaceFeedbackBurstCatalog(source, 0);

    assert.notEqual(slotted, source);
    assert.deepEqual(slotted.campaigns, source.campaigns);
    assert.deepEqual(slotted.personas, source.personas);
    assert.equal(
      feedbackBurstParticipantSeedEmail(source.personas[0], 0),
      "burst.taverna.01@burst.jointhesix.local",
    );
  });

  it("moves phones, emails and event titles while preserving scenario identity", () => {
    const source = fixtureCatalog();
    const slotted = namespaceFeedbackBurstCatalog(source, 4);

    assert.deepEqual(
      slotted.campaigns.map(({ slug, ordinal, title }) => ({
        slug,
        ordinal,
        title,
      })),
      [
        {
          slug: "taverna",
          ordinal: 1,
          title: "Δοκιμαστικό δείπνο — Ταβέρνα [burst slot 4]",
        },
        {
          slug: "rooftop",
          ordinal: 2,
          title: "Δοκιμαστικό δείπνο — Rooftop [burst slot 4]",
        },
      ],
    );
    assert.deepEqual(
      slotted.personas.map(({ id, campaign, phoneE164, messages }) => ({
        id,
        campaign,
        phoneE164,
        messages,
      })),
      [
        {
          id: "taverna_first",
          campaign: "taverna",
          phoneE164: "+30690040101",
          messages: [{ afterMs: 0, text: "5" }],
        },
        {
          id: "rooftop_first",
          campaign: "rooftop",
          phoneE164: "+30690040201",
          messages: [{ afterMs: 0, text: "4" }],
        },
      ],
    );
    assert.equal(
      feedbackBurstParticipantSeedEmail(slotted.personas[0], 4),
      "burst.slot4.taverna.01@burst.jointhesix.local",
    );
    assert.equal(slotted.extractionStub, false);
  });

  it("allocates disjoint deterministic identities across all ten slots", () => {
    const source = fixtureCatalog();
    const phones = new Set();
    const emails = new Set();
    const titles = new Set();

    for (let slot = 0; slot <= 9; slot += 1) {
      const catalog = namespaceFeedbackBurstCatalog(source, slot);
      for (const persona of catalog.personas) {
        const email = feedbackBurstParticipantSeedEmail(persona, slot);
        assert.equal(phones.has(persona.phoneE164), false);
        assert.equal(emails.has(email), false);
        phones.add(persona.phoneE164);
        emails.add(email);
      }
      for (const campaign of catalog.campaigns) {
        assert.equal(titles.has(campaign.title), false);
        titles.add(campaign.title);
      }
    }
  });

  it("fails before seeding when canonical identity or catalogue uniqueness drifted", () => {
    const wrongPhone = fixtureCatalog();
    wrongPhone.personas[0].phoneE164 = "+30691111111";
    assert.throws(
      () => namespaceFeedbackBurstCatalog(wrongPhone, 1),
      /phone drifted/u,
    );

    const duplicateSeat = fixtureCatalog();
    duplicateSeat.personas.push({ ...duplicateSeat.personas[0] });
    assert.throws(
      () => namespaceFeedbackBurstCatalog(duplicateSeat, 1),
      /duplicate persona id/u,
    );

    const unknownCampaign = fixtureCatalog();
    unknownCampaign.personas[0].campaign = "missing";
    assert.throws(
      () => namespaceFeedbackBurstCatalog(unknownCampaign, 1),
      /unknown campaign/u,
    );
  });

  it("fails closed for a nonzero slot under deterministic stub extraction", () => {
    assert.doesNotThrow(() =>
      assertFeedbackBurstFixtureSlotMode({ fixtureSlot: 0, stubMode: true }),
    );
    assert.doesNotThrow(() =>
      assertFeedbackBurstFixtureSlotMode({ fixtureSlot: 7, stubMode: false }),
    );
    assert.throws(
      () =>
        assertFeedbackBurstFixtureSlotMode({
          fixtureSlot: 1,
          stubMode: true,
        }),
      /requires --profile prova or --comparison qwen/u,
    );
  });

  it("does not inherit retained queue failures from another fixture slot", () => {
    const currentConversationIds = new Set(["slot-3-conversation"]);
    assert.equal(
      feedbackBurstFailedJobBelongsToSlot({
        fixtureSlot: 3,
        conversationId: "slot-0-conversation",
        currentConversationIds,
        failedReason: "Scripted burst persona old_case exhausted its stub",
      }),
      false,
    );
    assert.equal(
      feedbackBurstFailedJobBelongsToSlot({
        fixtureSlot: 3,
        conversationId: "slot-3-conversation",
        currentConversationIds,
        failedReason: "execution claim lost",
      }),
      true,
    );
    assert.equal(
      feedbackBurstFailedJobBelongsToSlot({
        fixtureSlot: 0,
        conversationId: undefined,
        currentConversationIds,
        failedReason: "Scripted burst persona current_case exhausted its stub",
      }),
      true,
    );
  });
});

function fixtureCatalog() {
  return {
    extractionStub: false,
    campaigns: [
      {
        slug: "taverna",
        ordinal: 1,
        title: "Δοκιμαστικό δείπνο — Ταβέρνα",
        venue: { label: "Taverna" },
      },
      {
        slug: "rooftop",
        ordinal: 2,
        title: "Δοκιμαστικό δείπνο — Rooftop",
        venue: { label: "Roof" },
      },
    ],
    personas: [
      {
        id: "taverna_first",
        campaign: "taverna",
        ordinal: 1,
        phoneE164: "+30690000101",
        displayName: "Κώστας",
        messages: [{ afterMs: 0, text: "5" }],
        expect: { lifecycle: "closed" },
      },
      {
        id: "rooftop_first",
        campaign: "rooftop",
        ordinal: 1,
        phoneE164: "+30690000201",
        displayName: "Ελένη",
        messages: [{ afterMs: 0, text: "4" }],
        expect: { lifecycle: "closed" },
      },
    ],
  };
}
