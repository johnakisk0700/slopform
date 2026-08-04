import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptsDirectory, "production-common.sh");
const source = readFileSync(scriptPath, "utf8");

test("the shared production primitives parse as Bash", () => {
  const check = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("backend activation stops the old worker before enabling new writers", () => {
  const start = source.indexOf("production_activate_scope() {");
  const end = source.indexOf("\nproduction_keep_contains() {", start);
  assert.ok(start >= 0 && end > start, "activation function was not found");
  const activation = source.slice(start, end);

  const stopWorker = activation.indexOf(
    '"${production_compose[@]}" stop worker',
  );
  const startApi = activation.indexOf(
    '"${production_compose[@]}" up -d --no-build --no-deps --wait --wait-timeout "$wait_timeout" api',
  );
  const waitApi = activation.indexOf('production_wait_for_url api "$api_url"');
  const startWorker = activation.indexOf(
    '"${production_compose[@]}" up -d --no-build --no-deps --wait --wait-timeout "$wait_timeout" worker',
  );

  assert.ok(stopWorker >= 0, "worker stop barrier is missing");
  assert.ok(startApi > stopWorker, "API starts before the old worker stops");
  assert.ok(
    waitApi > startApi,
    "API readiness is not checked after activation",
  );
  assert.ok(
    startWorker > waitApi,
    "new worker starts before the new API passes readiness",
  );
});
