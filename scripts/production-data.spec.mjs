import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptsDirectory, "production-data.sh");
const source = readFileSync(scriptPath, "utf8");

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

function embeddedRemoteScripts() {
  const scripts = [];
  const pattern =
    /IFS= read -r -d '' ([a-z_]+) <<'REMOTE' \|\| true\n([\s\S]*?)\nREMOTE/g;

  for (const match of source.matchAll(pattern)) {
    scripts.push({ name: match[1], source: match[2] });
  }

  return scripts;
}

test("the local entrypoint and every embedded remote program parse as Bash", () => {
  const localCheck = spawnSync("bash", ["-n", scriptPath], {
    encoding: "utf8",
  });
  assert.equal(localCheck.status, 0, localCheck.stderr);

  const remoteScripts = embeddedRemoteScripts();
  assert.equal(remoteScripts.length, 6);

  for (const remoteScript of remoteScripts) {
    const check = spawnSync("bash", ["-n"], {
      input: remoteScript.source,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, `${remoteScript.name}: ${check.stderr}`);
  }
});

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

test("the transfer contract is logical-only and release-state guarded", () => {
  const remoteSource = embeddedRemoteScripts()
    .map((script) => script.source)
    .join("\n");

  assert.doesNotMatch(remoteSource, /\bgit\b/);
  assert.doesNotMatch(remoteSource, /\bRELEASE_TAG=/);
  assert.doesNotMatch(source, /docker\s+(?:compose\s+)?(?:volume|cp)\b/);
  assert.doesNotMatch(source, /\b(?:redis-dump|redis-check-rdb|RESTORE)\b/);

  assert.match(remoteSource, /shared\/release-state\.env/);
  assert.match(remoteSource, /MIGRATE_RELEASE_TAG == "\$expected_sha"/);
  assert.match(remoteSource, /API_RELEASE_TAG == "\$expected_sha"/);
  assert.match(remoteSource, /WORKER_RELEASE_TAG == "\$expected_sha"/);
  assert.match(remoteSource, /production_compose_init "\$current_link"/);
  assert.match(remoteSource, /\/var\/lock\/join-the-six-production\.lock/);
  assert.doesNotMatch(
    source,
    /PRODUCTION_DEPLOY_LOCK_FILE|configured_deploy_lock/,
  );
  assert.match(
    remoteSource,
    /current release differs from the backend release; run deploy backend or all/,
  );
  assert.doesNotMatch(source, /find "\$migration_directory"[^\n]*-maxdepth/);
});

test("push preserves the explicit database replacement safety boundary", () => {
  assert.match(source, /pg_dump[\s\S]*--format=custom/);
  assert.match(source, /--schema=public/);
  assert.match(source, /--schema=drizzle/);
  assert.match(source, /pg_restore[\s\S]*--clean[\s\S]*--if-exists/);
  assert.match(source, /--no-owner/);
  assert.match(source, /--no-acl/);
  assert.match(source, /--single-transaction/);

  assert.match(source, /mongodump[\s\S]*--gzip[\s\S]*--archive/);
  assert.match(source, /--excludeCollectionsWithPrefix system\./);
  assert.match(
    source,
    /filter\(\(entry\) => !entry\.name\.startsWith\("system\."\)\)/,
  );
  assert.match(source, /options: canonical\(entry\.options \?\? \{\}\)/);
  assert.match(source, /mongorestore[\s\S]*--nsFrom[\s\S]*--nsTo/);
  assert.match(source, /--stopOnError/);
  assert.match(source, /redis-cli --no-auth-warning FLUSHALL SYNC/);

  assert.match(source, /sha256sum --check --strict sha256\.manifest/);
  assert.match(source, /pre-import-/);
  assert.match(source, /API and worker were left stopped/);
  assert.match(source, /no automatic rollback was attempted/);
});

test("pre-import backups become visible only after both archives validate", () => {
  const importProgram = embeddedRemoteScripts().find(
    (script) => script.name === "remote_import_source",
  )?.source;
  assert.ok(importProgram);

  const partialPosition = importProgram.indexOf(
    "production_prepare_partial_backup",
  );
  const postgresValidationPosition = importProgram.indexOf(
    'pg_restore --list <"$partial_backup_directory/postgres.dump"',
  );
  const mongoValidationPosition = importProgram.indexOf(
    '<"$partial_backup_directory/mongo.archive.gz" >/dev/null',
  );
  const commitPosition = importProgram.indexOf(
    "production_commit_partial_backup",
  );
  const replacementPosition = importProgram.indexOf(
    'note_remote "replacing PostgreSQL from verified custom dump"',
  );

  assert.ok(partialPosition >= 0);
  assert.ok(postgresValidationPosition > partialPosition);
  assert.ok(mongoValidationPosition > postgresValidationPosition);
  assert.ok(commitPosition > mongoValidationPosition);
  assert.ok(replacementPosition > commitPosition);
  assert.match(importProgram, /production_cleanup_partial_backup/);
});

test("remote backup and eval commands cannot consume the remaining bash-s program", () => {
  const importProgram = embeddedRemoteScripts().find(
    (script) => script.name === "remote_import_source",
  )?.source;
  assert.ok(importProgram);

  const postgresBackup = importProgram.slice(
    importProgram.indexOf('note_remote "taking pre-import PostgreSQL'),
    importProgram.indexOf('note_remote "taking pre-import MongoDB'),
  );
  const mongoBackup = importProgram.slice(
    importProgram.indexOf('note_remote "taking pre-import MongoDB'),
    importProgram.indexOf("chmod 0600", importProgram.indexOf("mongodump")),
  );

  assert.match(postgresBackup, /<\/dev\/null/u);
  assert.match(mongoBackup, /<\/dev\/null/u);
  assert.match(
    importProgram,
    /redis-cli --no-auth-warning FLUSHALL SYNC[\s\S]*?<\/dev\/null/u,
  );
  assert.match(importProgram, /run --rm --no-deps migrate <\/dev\/null/u);
});

test("remote cleanup is armed before validation and stop-state messages are phase-aware", () => {
  const importProgram = embeddedRemoteScripts().find(
    (script) => script.name === "remote_import_source",
  )?.source;
  assert.ok(importProgram);

  const trapPosition = importProgram.indexOf("trap 'finish_import $?' EXIT");
  const lockPosition = importProgram.indexOf('exec 9>"$deployment_lock"');
  const destructivePosition = importProgram.indexOf("destructive_phase=yes");
  const stopPosition = importProgram.indexOf(
    '"${compose[@]}" stop api worker',
    destructivePosition,
  );

  assert.ok(trapPosition >= 0 && trapPosition < lockPosition);
  assert.ok(destructivePosition >= 0 && destructivePosition < stopPosition);
  assert.match(
    importProgram,
    /failed before the application stop\/data replacement phase/,
  );
  assert.doesNotMatch(source, /treat production API\/worker as stopped/);
});

test("the mandatory quiescence attestation cannot override detected writers", () => {
  assert.match(source, /CONFIRM_LOCAL_DATA_QUIESCED/);
  assert.doesNotMatch(source, /overriding local writer signals/);
  assert.match(
    source,
    /local data is not demonstrably quiescent; stop every reported writer before retrying/,
  );
});

test("seal has one fixed marker and no CLI reversal path", () => {
  assert.match(
    source,
    /readonly seal_marker=\/var\/lib\/join-the-six\/data-import-window\.sealed/,
  );
  assert.match(source, /this CLI has no unseal command/);
  assert.doesNotMatch(source, /^\s*unseal\)/m);
});
