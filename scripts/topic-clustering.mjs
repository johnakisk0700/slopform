import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "apps/topic-clustering");
const environment = path.join(directory, ".venv");
const python = path.join(environment, "bin/python");

function run(executable, args, timeout = 180_000) {
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: "inherit",
    timeout,
    shell: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

switch (process.argv[2]) {
  case "setup":
    run("python3", [
      "-c",
      'import sys; assert (3, 11) <= sys.version_info[:2] < (3, 13), "Python 3.11 or 3.12 is required"',
    ]);
    run("python3", ["-m", "venv", environment]);
    run(
      python,
      [
        "-m",
        "pip",
        "install",
        "--no-deps",
        "--require-hashes",
        "--only-binary=:all:",
        "-r",
        path.join(directory, "requirements.lock"),
      ],
      600_000,
    );
    break;
  case "test":
    if (!existsSync(python)) {
      console.error(
        "Run pnpm topic-clustering:setup first (Python 3.11/3.12).",
      );
      process.exit(1);
    }
    run(python, [
      "-I",
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      path.join(directory, "tests"),
      "-p",
      "test_*.py",
      "-v",
    ]);
    break;
  default:
    console.error("Usage: node scripts/topic-clustering.mjs setup|test");
    process.exit(2);
}
