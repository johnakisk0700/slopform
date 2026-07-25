import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Fails the repository check when the committed API contract or the generated
 * admin client no longer matches the backend source.
 *
 * The regeneration is the check: this script fingerprints the generated files,
 * runs `pnpm api:generate`, and compares. Git state is deliberately not
 * consulted, so an unrelated uncommitted edit elsewhere cannot fail the check
 * and a stale artifact cannot pass it. Regenerated files are left in place —
 * a failure only asks the developer to review and commit them.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const generatedPaths = [
  path.join(repositoryRoot, "apps/backend/openapi/openapi.json"),
  path.join(repositoryRoot, "apps/admin/src/api/generated"),
];

function filesBelow(entryPath) {
  if (!existsSync(entryPath)) return [];

  return readdirSync(entryPath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = path.join(entryPath, entry.name);
    if (entry.isDirectory()) return filesBelow(childPath);
    return entry.isFile() ? [childPath] : [];
  });
}

function fingerprint() {
  const files = generatedPaths.flatMap((entryPath) => {
    if (!existsSync(entryPath)) return [];
    return statSync(entryPath).isDirectory()
      ? filesBelow(entryPath)
      : [entryPath];
  });

  return new Map(
    files
      .sort()
      .map((file) => [
        path.relative(repositoryRoot, file),
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]),
  );
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
      "\nThe files above have just been regenerated for you. Review the diff," +
        "\ncommit it with the backend change, and rerun `pnpm check`." +
        "\nNever edit generated files by hand: run `pnpm api:generate`.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Verified ${before.size} generated API files against the backend contract.`,
    );
  }
}
