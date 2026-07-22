import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const docsRoot = path.join(repositoryRoot, "docs");

function markdownFilesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFilesBelow(entryPath);
    return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

const documentationFiles = markdownFilesBelow(docsRoot);
const instructionFiles = [
  path.join(repositoryRoot, "AGENTS.md"),
  path.join(repositoryRoot, "apps/backend/AGENTS.md"),
  path.join(repositoryRoot, "apps/web/AGENTS.md"),
];
const scannedFiles = [
  path.join(repositoryRoot, "README.md"),
  ...instructionFiles,
  ...documentationFiles,
];

const problems = [];
const linkedDocs = new Set();
const markdownLink = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

for (const file of scannedFiles) {
  if (!existsSync(file)) {
    problems.push(
      `Missing required documentation file: ${path.relative(repositoryRoot, file)}`,
    );
    continue;
  }

  const contents = readFileSync(file, "utf8");

  if (file.startsWith(docsRoot) && !contents.startsWith("# ")) {
    problems.push(
      `${path.relative(repositoryRoot, file)} must start with one H1 heading`,
    );
  }

  const mermaidOpenings = contents.match(/^```mermaid\s*$/gm)?.length ?? 0;
  if (mermaidOpenings > 0) {
    let insideFence = false;
    let openMermaid = false;
    let closedMermaid = 0;

    for (const line of contents.split("\n")) {
      if (!insideFence && line.trim() === "```mermaid") {
        insideFence = true;
        openMermaid = true;
      } else if (insideFence && line.trim() === "```") {
        if (openMermaid) closedMermaid += 1;
        insideFence = false;
        openMermaid = false;
      }
    }

    if (closedMermaid !== mermaidOpenings) {
      problems.push(
        `${path.relative(repositoryRoot, file)} has an unclosed Mermaid fence`,
      );
    }
  }

  for (const match of contents.matchAll(markdownLink)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;

    const targetPath = decodeURIComponent(
      target.split("#", 1)[0].split("?", 1)[0],
    );
    if (!targetPath) continue;

    const resolved = path.resolve(path.dirname(file), targetPath);
    if (!existsSync(resolved)) {
      problems.push(
        `${path.relative(repositoryRoot, file)} links to missing ${path.relative(repositoryRoot, resolved)}`,
      );
      continue;
    }

    if (resolved.startsWith(docsRoot) && resolved.endsWith(".md")) {
      linkedDocs.add(resolved);
    }
  }
}

for (const file of documentationFiles) {
  if (file === path.join(docsRoot, "README.md")) continue;
  if (!linkedDocs.has(file)) {
    problems.push(
      `${path.relative(repositoryRoot, file)} is orphaned; link it from the relevant index`,
    );
  }
}

if (problems.length > 0) {
  console.error("Documentation verification failed:\n");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${documentationFiles.length} documentation files and their local links.`,
  );
}
