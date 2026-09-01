import "dotenv/config";

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { createDatabase } from "@slopform/database";

import {
  WordpressProfileImportService,
  type WordpressProfileImportOutcome,
} from "../modules/participants/wordpress-profile-import.service.js";
import {
  wordpressProfileExportSchema,
  type CanonicalWordpressProfile,
} from "../modules/participants/wordpress-profile-import.schemas.js";
import {
  isCanonicalParticipantProfileComplete,
  mapWordpressProfile,
} from "../modules/participants/wordpress-profile.mapper.js";
import { parseWordpressWxrProfiles } from "../modules/participants/wordpress-wxr.parser.js";

const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

interface CliOptions {
  readonly apply: boolean;
  readonly file: string;
}

interface ImportFailure {
  readonly sourceProfileId: string;
  readonly code: string;
  readonly issues?: readonly string[];
}

function printUsage(): void {
  process.stdout.write(
    "Usage: import-wordpress-profiles --file <export.xml|json> [--apply]\n" +
      "Dry-run is the default. --apply requires DATABASE_URL.\n",
  );
}

function parseOptions(arguments_: readonly string[]): CliOptions {
  let file: string | undefined;
  let apply = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    }

    if (argument === "--apply") {
      apply = true;
      continue;
    }

    if (argument === "--") {
      continue;
    }

    if (argument === "--file") {
      file = arguments_[index + 1];
      index += 1;
      continue;
    }

    if (argument?.startsWith("--file=")) {
      file = argument.slice("--file=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
  }

  if (!file) {
    throw new Error("--file is required");
  }

  return {
    apply,
    file: resolve(process.env.INIT_CWD ?? process.cwd(), file),
  };
}

async function loadExport(file: string) {
  const metadata = await stat(file);

  if (!metadata.isFile()) {
    throw new Error("Import path is not a file");
  }

  if (metadata.size > MAX_EXPORT_BYTES) {
    throw new Error("Import file exceeds the 20 MiB safety limit");
  }

  const content = await readFile(file, "utf8");
  const raw = content.trimStart().startsWith("<?xml")
    ? parseWordpressWxrProfiles(content)
    : (JSON.parse(content) as unknown);
  return wordpressProfileExportSchema.parse(raw);
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const export_ = await loadExport(options.file);
  const failures: ImportFailure[] = [];
  const eligible: CanonicalWordpressProfile[] = [];
  let eligibleComplete = 0;
  let eligibleIncomplete = 0;
  let skippedTrashed = 0;

  for (const row of export_.profiles) {
    if (row.sourceStatus === "trash") {
      skippedTrashed += 1;
      continue;
    }

    const mapped = mapWordpressProfile(row);

    if (!mapped.ok) {
      failures.push({
        sourceProfileId: mapped.sourceProfileId,
        code: mapped.code,
        issues: mapped.issues,
      });
      continue;
    }

    eligible.push(mapped.value);

    if (isCanonicalParticipantProfileComplete(mapped.value.profile)) {
      eligibleComplete += 1;
    } else {
      eligibleIncomplete += 1;
    }
  }

  const counts = {
    imported: 0,
    updated: 0,
    unchanged: 0,
    linkedDuplicate: 0,
    conflicts: 0,
  };

  if (options.apply) {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (!connectionString) {
      throw new Error("DATABASE_URL is required with --apply");
    }

    const client = createDatabase({
      applicationName: "wordpress-profile-import-v1",
      connectionString,
      maxConnections: 1,
    });
    const importer = new WordpressProfileImportService(client.db);

    try {
      for (const profile of eligible) {
        let outcome: WordpressProfileImportOutcome;

        try {
          outcome = await importer.importOne(profile);
        } catch {
          throw new Error(
            `Database import failed for source profile ${profile.sourceProfileId}`,
          );
        }

        if (outcome.status === "linked_duplicate") {
          counts.linkedDuplicate += 1;
        } else if (outcome.status === "conflict") {
          counts.conflicts += 1;
          failures.push({
            sourceProfileId: profile.sourceProfileId,
            code: outcome.code,
          });
        } else {
          counts[outcome.status] += 1;
        }
      }
    } finally {
      await client.pool.end();
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.apply ? "apply" : "dry-run",
        sourceExportedAt: export_.exportedAt,
        total: export_.profiles.length,
        eligible: eligible.length,
        eligibleComplete,
        eligibleIncomplete,
        skippedTrashed,
        ...counts,
        rejected: failures.length,
        failures,
      },
      null,
      2,
    )}\n`,
  );

  if (failures.length > 0) {
    process.exitCode = 2;
  }
}

run().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown import error";
  process.stderr.write(`WordPress profile import failed: ${message}\n`);
  process.exitCode = 1;
});
