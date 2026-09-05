import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RESERVED_PHONE_PREFIX,
  conversationRowToInspectionThread,
  reservedConversationQuery,
} from "./burst-inspect.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const inspectSource = readFileSync(
  path.join(scriptsDirectory, "burst-inspect.mjs"),
  "utf8",
);

test("burst inspection reads reserved feedback_conversations and never opens Mongo", () => {
  assert.equal(RESERVED_PHONE_PREFIX, "+3069000");
  assert.match(inspectSource, /from feedback_conversations/u);
  assert.match(inspectSource, /phone_e164 like \$1/u);
  assert.match(
    inspectSource,
    /respondent_participant_id = any\(\$1::uuid\[\]\)/u,
  );
  assert.doesNotMatch(inspectSource, /conversation_threads/u);
  assert.doesNotMatch(
    inspectSource,
    /MongoClient|MONGODB_URI|loadMongoDriver/u,
  );
  assert.doesNotMatch(inspectSource, /\binsert\b|\bupdate\b|\bdelete\b/iu);
});

test("reserved conversation filters cannot drop the participant scope", () => {
  const unfiltered = reservedConversationQuery();
  assert.match(
    unfiltered.text,
    /respondent_participant_id = any\(\$1::uuid\[\]\)/u,
  );
  assert.doesNotMatch(unfiltered.text, /needs_attention is true/u);

  const flagged = reservedConversationQuery({ needsAttention: true });
  assert.match(
    flagged.text,
    /respondent_participant_id = any\(\$1::uuid\[\]\)/u,
  );
  assert.match(flagged.text, /needs_attention is true/u);

  assert.throws(
    () => reservedConversationQuery({ respondentParticipantId: "widening" }),
    /widen/,
  );
});

test("inspection threads keep the document-shaped fields consumers print", () => {
  const thread = conversationRowToInspectionThread({
    id: "conversation-1",
    campaign_id: "campaign-1",
    respondent_participant_id: "participant-1",
    phone_at_launch: "+306900000001",
    lifecycle_state: "open",
    lifecycle_reason: null,
    needs_attention: true,
    hostile_turns: 2,
    created_at: new Date("2026-09-05T12:00:00.000Z"),
    messages: [{ actor: "bot", text: "hello", at: "2026-09-05T12:00:00.000Z" }],
    goals: [{ key: "event_score", status: "asked" }],
    attention_reasons: [{ kind: "handoff" }],
  });

  assert.equal(thread._id, "conversation-1");
  assert.equal(thread.respondentParticipantId, "participant-1");
  assert.deepEqual(thread.lifecycle, { state: "open", reason: null });
  assert.equal(thread.needsAttention, true);
  assert.equal(thread.hostileTurns, 2);
  assert.equal(thread.goals[0].key, "event_score");
  assert.equal(thread.messages[0].actor, "bot");
  assert.equal(thread.attentionReasons[0].kind, "handoff");
});
