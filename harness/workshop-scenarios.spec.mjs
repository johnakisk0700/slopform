import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixtureId,
  projectMessages,
  validateConversation,
} from "./workshop-scenarios.mjs";

function example() {
  return {
    participantId: "p001",
    outcome: "complete",
    messages: [
      { seq: 1, actor: "bot", text: "Πώς σου φάνηκε;", offsetSeconds: 0 },
      {
        seq: 2,
        actor: "participant",
        text: "Πολύ βιαστική η άσκηση.",
        offsetSeconds: 42,
      },
    ],
    expectations: {
      reviewStatus: "draft",
      findings: [
        { kind: "general", meaning: "Βιαστική άσκηση", sourceSeqs: [2] },
      ],
      mustNotInfer: [],
      corrections: [],
    },
  };
}
const profile = { id: "p001", terminalOutcome: "complete" };

test("the pilot interview does not grow into multiple follow-up questions", () => {
  const conversation = example();
  conversation.messages.push(
    { seq: 3, actor: "bot", text: "Ποια άσκηση;", offsetSeconds: 50 },
    { seq: 4, actor: "participant", text: "Με το φως", offsetSeconds: 60 },
    { seq: 5, actor: "bot", text: "Και βαθμολογία;", offsetSeconds: 70 },
  );
  assert.throws(
    () => validateConversation(conversation, profile),
    /one follow-up/u,
  );
});

test("evidence must cite the participant, never a bot suggestion or missing turn", () => {
  for (const sourceSeqs of [[1], [99], [2, 2]]) {
    const conversation = example();
    conversation.expectations.findings[0].sourceSeqs = sourceSeqs;
    assert.throws(() => validateConversation(conversation, profile));
  }
  validateConversation(example(), profile);
});

test("silence cannot acquire invented testimony or findings", () => {
  const conversation = example();
  conversation.outcome = "silent";
  const silentProfile = { ...profile, terminalOutcome: "silent" };
  assert.throws(() => validateConversation(conversation, silentProfile));
  conversation.messages.splice(1);
  conversation.expectations.findings = [];
  validateConversation(conversation, silentProfile);
});

test("reversed corrections, mismatched participants and unordered messages fail", () => {
  const conversation = example();
  assert.throws(() =>
    validateConversation(conversation, { ...profile, id: "p002" }),
  );
  conversation.messages[1].offsetSeconds = 0;
  assert.throws(() => validateConversation(conversation, profile));
  conversation.messages[1].offsetSeconds = 42;
  conversation.expectations.corrections = [
    {
      supersededSeqs: [2],
      replacementSeqs: [2],
      meaning: "Impossible chronology",
    },
  ];
  assert.throws(() => validateConversation(conversation, profile));
});

test("PG message projection is stable, separates provenance and excludes expected findings", () => {
  const messages = projectMessages(example(), 0);
  assert.deepEqual(messages, projectMessages(example(), 0));
  assert.equal(messages[0].ingressId, null);
  assert.equal(messages[1].outboxId, null);
  assert.notEqual(messages[0].outboxId, messages[1].ingressId);
  assert.equal(messages[0].at, "2026-09-12T15:30:00.000Z");
  assert.equal(messages[1].at, "2026-09-12T15:30:42.000Z");
  assert.equal(Object.hasOwn(messages[1], "expectations"), false);
  assert.notEqual(
    fixtureId("p001:participant"),
    fixtureId("p001:conversation"),
  );
});
