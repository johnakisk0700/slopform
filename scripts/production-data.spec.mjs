import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptsDirectory, "production-data.sh");

function runScript(arguments_, environment = {}) {
  return spawnSync("bash", [scriptPath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      CONFIRM_LOCAL_DATA_QUIESCED: "",
      CONFIRM_PRODUCTION_DATA_PUSH: "",
      CONFIRM_SEAL_DATA_IMPORT_WINDOW: "",
      ...environment,
    },
    timeout: 5_000,
  });
}

test("destructive commands reject missing domain confirmations before connectivity", () => {
  const push = runScript(["push"]);
  assert.equal(push.status, 1);
  assert.match(
    push.stderr,
    /CONFIRM_PRODUCTION_DATA_PUSH=slopform\.example\.com/,
  );
  assert.doesNotMatch(push.stderr, /SSH private key/);

  const quiescence = runScript(["push"], {
    CONFIRM_PRODUCTION_DATA_PUSH: "slopform.example.com",
  });
  assert.equal(quiescence.status, 1);
  assert.match(
    quiescence.stderr,
    /CONFIRM_LOCAL_DATA_QUIESCED=I_HAVE_STOPPED_ALL_JOIN_THE_SIX_LOCAL_WRITERS/,
  );
  assert.doesNotMatch(quiescence.stderr, /SSH private key/);

  const seal = runScript(["seal"]);
  assert.equal(seal.status, 1);
  assert.match(
    seal.stderr,
    /CONFIRM_SEAL_DATA_IMPORT_WINDOW=slopform\.example\.com/,
  );
  assert.doesNotMatch(seal.stderr, /SSH private key/);
});
