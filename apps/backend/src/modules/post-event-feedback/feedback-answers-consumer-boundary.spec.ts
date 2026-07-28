import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Fails when anything outside this module starts reading `feedback_answers`.
 *
 * Not a layering rule for its own sake. A participant answered `avoid` about an
 * attendee she named, giving as her reason that she does not sit with
 * foreigners. The row is stored on purpose — discarding it would be us deciding
 * on her behalf with nothing on file to say we did — and it is marked
 * `matching_hold`, because an `avoid` is a statement somebody made and not an
 * instruction to us. Nothing in the schema stops a future module from turning
 * these rows into seating constraints and quietly honouring that one.
 *
 * So this spec is the marker that speaks at the moment of the mistake, to
 * somebody who was not looking for it: the first import in a new module turns
 * the suite red and prints the decision. A column can be ignored and a document
 * can go unread; a failing test in the way of a merge cannot.
 *
 * Widening the allowlist is a real decision and may well be the right one. Read
 * the invariant named in the failure message first, filter `matching_hold`, and
 * add the path here with the reason.
 */
const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);

/**
 * Who may name the table. The schema package owns it and its migrations; this
 * module is the only consumer, and every read of it goes through
 * `extraction/results.repository.ts` — which is what makes one filter in one
 * place enough.
 */
const ALLOWED_PREFIXES = [
  "packages/database/",
  "apps/backend/src/modules/post-event-feedback/",
] as const;

/**
 * Three ways to reach the table: the Drizzle table object, its name in raw SQL,
 * and the raw column a hand-written query would filter avoids on
 * (`question_key = 'avoid'`). `question_key` exists on this table and on its
 * withdrawal tombstones and nowhere else in the schema, so naming it at all is
 * writing SQL against these rows.
 */
const TABLE_REFERENCES = [
  /\bfeedbackAnswers\b/,
  /\bfeedback_answers\b/,
  /\bquestion_key\b/,
] as const;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "generated",
  ".turbo",
]);

/**
 * TypeScript only. A raw `.sql` file under `packages/database/drizzle/` is
 * allowlisted anyway, and every consumer this guard exists for — a matching,
 * seating or pairing module — would arrive as an import in an application.
 */
function sourceFiles(directory: string, relative = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${REPOSITORY_ROOT}${directory}`, {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...sourceFiles(`${directory}/${entry.name}`, child));
      }
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(child);
    }
  }
  return found;
}

const BOUNDARY_DECISION = `A file outside apps/backend/src/modules/post-event-feedback references feedback_answers.

An answer row is a statement a participant made, not an instruction to us. Some
rows carry matching_hold = true: the extraction run that recorded them also found
the participant abusing the person the answer is about, and honouring one of
those as a seating constraint would make the platform act on that abuse against
the person it was aimed at. Nothing in the row's shape stops that from happening
by accident, which is why this boundary is a test.

Read "An avoid row is a statement, not an instruction" in
docs/backend/modules/post-event-feedback.md before consuming these rows. Then
exclude matching_hold rows, and add the file to ALLOWED_PREFIXES here with the
reason it is allowed.`;

describe("feedback_answers stays inside the post-event feedback module", () => {
  it("has no consumer outside the module, the schema package and its migrations", () => {
    const offenders: string[] = [];

    for (const root of ["apps", "packages"]) {
      for (const file of sourceFiles(root)) {
        const path = `${root}/${file}`;
        if (ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
          continue;
        }
        const lines = readFileSync(`${REPOSITORY_ROOT}${path}`, "utf8").split(
          "\n",
        );
        lines.forEach((line, index) => {
          const matched = TABLE_REFERENCES.find((pattern) =>
            pattern.test(line),
          );
          if (matched) {
            // The line number and what matched, so the failure names the place
            // rather than only the rule.
            offenders.push(`${path}:${index + 1} matched ${String(matched)}`);
          }
        });
      }
    }

    expect(offenders, BOUNDARY_DECISION).toStrictEqual([]);
  });

  it("points at an invariant that is actually written down", () => {
    // The failure message above sends a stranger to a named section. If the
    // section is renamed or deleted the message becomes a dead end, and the
    // person it stops has nothing to read.
    const moduleDocumentation = readFileSync(
      `${REPOSITORY_ROOT}docs/backend/modules/post-event-feedback.md`,
      "utf8",
    );

    expect(moduleDocumentation).toContain(
      "### An avoid row is a statement, not an instruction",
    );
    expect(moduleDocumentation).toContain("matching_hold");
  });
});
