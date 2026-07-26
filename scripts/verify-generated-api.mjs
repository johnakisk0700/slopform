import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fails the repository check when the committed OpenAPI contract no longer
 * matches the backend source.
 *
 * The regeneration is the check: this script fingerprints
 * `apps/backend/openapi/openapi.json`, runs `pnpm api:generate`, and compares
 * that file alone. The admin client is produced as a side effect and is not
 * part of the drift comparison — it is a deterministic function of the
 * contract and is generated on demand. Git state is deliberately not
 * consulted, so an unrelated uncommitted edit elsewhere cannot fail the check
 * and a stale contract cannot pass it. Regenerated files are left in place —
 * a failure only asks the developer to review and commit the contract.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const contractPath = path.join(
  repositoryRoot,
  "apps/backend/openapi/openapi.json",
);

function fingerprint() {
  if (!existsSync(contractPath)) return new Map();

  return new Map([
    [
      path.relative(repositoryRoot, contractPath),
      createHash("sha256").update(readFileSync(contractPath)).digest("hex"),
    ],
  ]);
}

function describeDrift(before, after) {
  const drifted = [];

  for (const [file, hash] of after) {
    if (!before.has(file)) drifted.push(`added    ${file}`);
    else if (before.get(file) !== hash) drifted.push(`changed  ${file}`);
  }

  for (const file of before.keys()) {
    if (!after.has(file)) drifted.push(`removed  ${file}`);
  }

  return drifted.sort();
}

const before = fingerprint();
const generation = spawnSync("pnpm", ["api:generate"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});

if (generation.status !== 0) {
  console.error("Generating the API client failed:\n");
  console.error(generation.stdout ?? "");
  console.error(generation.stderr ?? String(generation.error ?? ""));
  process.exitCode = 1;
} else {
  const drifted = describeDrift(before, fingerprint());

  if (drifted.length > 0) {
    console.error(
      "The committed API contract is stale. Regeneration changed:\n",
    );
    for (const entry of drifted) console.error(`- ${entry}`);
    console.error(
      "\nThe OpenAPI document has just been regenerated for you. Review the" +
        "\ndiff, commit it with the backend change, and rerun `pnpm check`." +
        "\nNever edit generated files by hand: run `pnpm api:generate`." +
        "\nThe admin client is produced locally and is not committed.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Verified apps/backend/openapi/openapi.json against the backend contract.",
    );
  }
}
