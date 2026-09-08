import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "fixtures/workshop-feedback");
const outcomes = ["complete", "partial", "declined", "silent"];
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function fixtureId(value) {
  const bytes = Buffer.from(
    hash(`slopform-workshop-v1:${value}`).slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateConversation(conversation, profile) {
  assert.equal(conversation.participantId, profile.id, "Unknown participant");
  assert.equal(
    conversation.outcome,
    profile.terminalOutcome,
    "Outcome differs from profile",
  );
  assert.ok(outcomes.includes(conversation.outcome), "Unknown outcome");
  const messages = conversation.messages;
  assert.ok(
    Array.isArray(messages) && messages.length >= 1 && messages.length <= 16,
    "Message count",
  );
  assert.equal(messages[0].actor, "bot", "Invitation must come first");
  let previousTime = -1;
  for (const [index, message] of messages.entries()) {
    assert.equal(message.seq, index + 1, "Sequence must be contiguous");
    assert.ok(["bot", "participant"].includes(message.actor), "Unknown actor");
    assert.ok(
      typeof message.text === "string" &&
        message.text.trim().length > 0 &&
        message.text.length <= 1500,
      "Message text bound",
    );
    assert.ok(
      Number.isInteger(message.offsetSeconds) &&
        message.offsetSeconds > previousTime &&
        message.offsetSeconds <= 172800,
      "Message timing",
    );
    previousTime = message.offsetSeconds;
  }
  assert.ok(
    messages
      .slice(1)
      .filter(
        (message) => message.actor === "bot" && /[?;;]/u.test(message.text),
      ).length <= 1,
    "The authored interview allows one follow-up question",
  );
  const evidence = (references) => {
    assert.ok(
      Array.isArray(references) && references.length > 0,
      "Missing evidence",
    );
    assert.equal(
      new Set(references).size,
      references.length,
      "Duplicate evidence",
    );
    for (const seq of references) {
      assert.ok(
        Number.isInteger(seq) && messages[seq - 1]?.actor === "participant",
        "Evidence must cite participant testimony",
      );
    }
  };
  const expected = conversation.expectations;
  assert.equal(
    expected.reviewStatus,
    "draft",
    "Author expectations are drafts",
  );
  assert.ok(
    Array.isArray(expected.findings) && expected.findings.length <= 6,
    "Finding count",
  );
  for (const finding of expected.findings) {
    assert.ok(
      ["general", "activity_interest"].includes(finding.kind),
      "Finding kind",
    );
    assert.ok(
      typeof finding.meaning === "string" &&
        finding.meaning.trim() &&
        finding.meaning.length <= 500,
      "Finding meaning",
    );
    evidence(finding.sourceSeqs);
  }
  assert.ok(
    Array.isArray(expected.mustNotInfer) &&
      expected.mustNotInfer.every(
        (value) => typeof value === "string" && value.trim(),
      ),
    "Negative expectations",
  );
  assert.ok(
    Array.isArray(expected.corrections),
    "Corrections must be an array",
  );
  for (const correction of expected.corrections) {
    evidence(correction.supersededSeqs);
    evidence(correction.replacementSeqs);
    assert.ok(
      Math.max(...correction.supersededSeqs) <
        Math.min(...correction.replacementSeqs),
      "Correction must follow superseded testimony",
    );
    assert.ok(
      typeof correction.meaning === "string" && correction.meaning.trim(),
      "Correction meaning",
    );
  }
  if (conversation.outcome === "silent") {
    assert.equal(messages.length, 1, "Silence must not invent messages");
    assert.equal(
      expected.findings.length,
      0,
      "Silence must not invent findings",
    );
    assert.equal(
      expected.corrections.length,
      0,
      "Silence must not invent corrections",
    );
  } else {
    assert.ok(
      messages.some((message) => message.actor === "participant"),
      "Missing participant reply",
    );
  }
}

export function projectMessages(conversation, participantIndex) {
  const start =
    Date.parse("2026-09-12T15:30:00.000Z") + participantIndex * 60_000;
  return conversation.messages.map((message) => ({
    id: fixtureId(`${conversation.participantId}:message:${message.seq}`),
    seq: message.seq,
    actor: message.actor,
    text: message.text,
    providerMessageId: null,
    ingressId:
      message.actor === "participant"
        ? fixtureId(`${conversation.participantId}:ingress:${message.seq}`)
        : null,
    outboxId:
      message.actor === "bot"
        ? fixtureId(`${conversation.participantId}:outbox:${message.seq}`)
        : null,
    attention: null,
    at: new Date(start + message.offsetSeconds * 1000).toISOString(),
  }));
}

async function compileCorpus() {
  const profiles = await readJson(
    path.join(directory, "participant-profiles.json"),
  );
  assert.equal(profiles.synthetic, true);
  assert.equal(profiles.participants.length, 100);
  const byId = new Map(
    profiles.participants.map((profile) => [profile.id, profile]),
  );
  assert.equal(byId.size, 100, "Duplicate participant profiles");
  const names = (await readdir(path.join(directory, "batches")))
    .filter((name) => /^batch-\d\d\.json$/u.test(name))
    .sort();
  assert.equal(names.length, 10, "Expected ten accepted batches");
  const conversations = [];
  const sources = [];
  for (const name of names) {
    const text = await readFile(path.join(directory, "batches", name), "utf8");
    const batch = JSON.parse(text);
    assert.equal(batch.version, 1);
    assert.equal(batch.batchId, name.slice(0, -5));
    assert.equal(batch.generator.model, "gpt-5.6-luna");
    assert.ok(["xhigh", "max"].includes(batch.generator.reasoningEffort));
    assert.equal(batch.generator.promptVersion, 1);
    assert.equal(batch.conversations.length, 10);
    sources.push({
      file: `batches/${name}`,
      sha256: hash(text),
      ...batch.generator,
    });
    for (const conversation of batch.conversations) {
      validateConversation(
        conversation,
        byId.get(conversation.participantId) ?? {},
      );
      conversations.push(conversation);
    }
  }
  conversations.sort((a, b) => a.participantId.localeCompare(b.participantId));
  assert.equal(
    new Set(conversations.map((item) => item.participantId)).size,
    100,
    "Duplicate/missing conversations",
  );
  const { feedbackConversationStoredMessageSchema } = await import(
    pathToFileURL(
      path.join(
        root,
        "apps/backend/dist/modules/post-event-feedback/post-event-feedback-conversation.document.js",
      ),
    )
  );
  const rows = conversations.map((conversation, index) => {
    const messages = projectMessages(conversation, index);
    for (const message of messages)
      feedbackConversationStoredMessageSchema.parse({
        ...message,
        at: new Date(message.at),
      });
    return {
      scenarioId: conversation.participantId,
      respondentParticipantId: fixtureId(
        `${conversation.participantId}:participant`,
      ),
      conversationId: fixtureId(`${conversation.participantId}:conversation`),
      outcome: conversation.outcome,
      messages,
    };
  });
  const expectations = conversations.map((conversation, index) => ({
    scenarioId: conversation.participantId,
    ...conversation.expectations,
    findings: conversation.expectations.findings.map(
      ({ sourceSeqs, ...finding }) => ({
        ...finding,
        sourceMessageIds: sourceSeqs.map(
          (seq) => rows[index].messages[seq - 1].id,
        ),
      }),
    ),
  }));
  const counts = Object.fromEntries(
    outcomes.map((outcome) => [
      outcome,
      conversations.filter((item) => item.outcome === outcome).length,
    ]),
  );
  assert.deepEqual(counts, {
    complete: 55,
    partial: 30,
    declined: 5,
    silent: 10,
  });
  const manifest = {
    version: 1,
    synthetic: true,
    questionnaireContract: "workshop-feedback-draft-v1",
    runtimeImportReady: false,
    eventId: fixtureId("event"),
    campaignId: fixtureId("campaign"),
    participantCount: 100,
    messageCount: rows.reduce((sum, row) => sum + row.messages.length, 0),
    outcomes: counts,
    sources,
    authoringHashes: {},
  };
  for (const name of [
    "event-brief.json",
    "participant-profiles.json",
    "generation-prompt.md",
  ])
    manifest.authoringHashes[name] = hash(
      await readFile(path.join(directory, name)),
    );
  return {
    "manifest.json": manifest,
    "pg-messages.json": {
      version: 1,
      synthetic: true,
      runtimeImportReady: false,
      conversations: rows,
    },
    "expected-findings.json": {
      version: 1,
      synthetic: true,
      reviewStatus: "draft",
      scenarios: expectations,
    },
  };
}

async function main(command) {
  assert.ok(
    ["build", "check"].includes(command),
    "Usage: workshop-scenarios.mjs build|check",
  );
  const output = await compileCorpus();
  const target = path.join(directory, "generated");
  const formatting = await resolveConfig(path.join(root, "package.json"));
  if (command === "build") await mkdir(target, { recursive: true });
  for (const [name, value] of Object.entries(output)) {
    const file = path.join(target, name);
    if (command === "build")
      await writeFile(
        file,
        await format(JSON.stringify(value), { ...formatting, parser: "json" }),
      );
    else
      assert.deepEqual(
        await readJson(file),
        value,
        `Stale generated artifact: ${name}`,
      );
  }
  console.log(JSON.stringify(output["manifest.json"].outcomes));
  console.log(
    "100 synthetic participants validated against the stored-message schema; runtime import remains disabled.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
