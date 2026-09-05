import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mongoInit = readFileSync(
  path.join(repositoryRoot, "docker/mongo-init/10-app-user.js"),
  "utf8",
);

test("fresh Mongo volumes keep assistant indexes and stop creating feedback ones", () => {
  assert.match(mongoInit, /createCollection\("conversation_threads"\)/u);
  assert.match(mongoInit, /name: "conversation_owner_purpose_updated_idx"/u);
  assert.match(mongoInit, /name: "conversation_purpose_state_updated_idx"/u);

  assert.doesNotMatch(
    mongoInit,
    /feedback_conversation_open_phone_unique_idx/u,
  );
  assert.doesNotMatch(mongoInit, /feedback_conversation_campaign_updated_idx/u);
  assert.doesNotMatch(mongoInit, /feedback_conversation_work_due_idx/u);
  assert.doesNotMatch(mongoInit, /feedback_conversation_lifecycle_state_idx/u);
  assert.doesNotMatch(
    mongoInit,
    /feedback_conversation_attention_updated_idx/u,
  );
  assert.doesNotMatch(mongoInit, /dropIndex|dropIndexes/u);
});
