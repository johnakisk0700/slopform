import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../infrastructure/config/environment.js";
import { TopicClusteringClient } from "./topic-clustering.client.js";

const directories: string[] = [];
const request = {
  version: 1 as const,
  requestId: "run",
  documents: [{ id: "one", text: "hello", embedding: [1, 2] }],
  options: { minTopicSize: 3, minSamples: 2, randomSeed: 42 },
};
const resultCode = `console.log(JSON.stringify({version:1,requestId:'run',type:'result',topics:[],assignments:[{documentId:'one',topicId:null}]}));`;
async function createClient(code: string) {
  const directory = await mkdtemp(join(tmpdir(), "topic-child-"));
  directories.push(directory);
  const executable = join(directory, "fixture.mjs");
  await writeFile(executable, `#!${process.execPath}\n${code}\n`, {
    mode: 0o700,
  });
  return {
    directory,
    client: new TopicClusteringClient(
      new ConfigService<Environment, true>({
        FEEDBACK_TOPIC_CLUSTERING_PYTHON: executable,
        FEEDBACK_TOPIC_CLUSTERING_SCRIPT: join(directory, "cluster.py"),
      }),
    ),
  };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("topic clustering process lifecycle", () => {
  it("writes one JSON request then EOF and accepts one terminal record on clean exit", async () => {
    const { client } = await createClient(
      `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const r=JSON.parse(input);if(r.requestId!=='run'||process.argv[2]!=='-I'||process.argv[3]!=='-B'||process.env.OPENROUTER_API_KEY)process.exit(9);console.log(JSON.stringify({version:1,requestId:'run',type:'progress',stage:'validate'}));${resultCode}});`,
    );
    const progress = vi.fn();
    await expect(
      client.cluster(request, new AbortController().signal, progress),
    ).resolves.toMatchObject({
      assignments: [{ documentId: "one", topicId: null }],
    });
    expect(progress).toHaveBeenCalledWith("validate");
    await client.onModuleDestroy();
  });
  it.each([
    `${resultCode}process.exit(2);`,
    `${resultCode}${resultCode}`,
    "console.log('private invalid json');",
    "process.stdout.write('x'.repeat(2200000));",
    "process.stderr.write('x'.repeat(70000));",
    "process.exit(0);",
  ])(
    "fails closed on nonzero exit, duplicate/missing result and output overflow",
    async (code) => {
      const { client } = await createClient(code);
      await expect(
        client.cluster(request, new AbortController().signal, () => undefined),
      ).rejects.toMatchObject({ retryable: false });
      await client.onModuleDestroy();
    },
  );
  it("kills and reaps a child ignoring SIGTERM before cancellation returns", async () => {
    const { client, directory } = await createClient(
      `import{writeFileSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';writeFileSync(join(dirname(fileURLToPath(import.meta.url)),'pid'),String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const pending = client.cluster(request, controller.signal, () => undefined);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "clustering_cancelled_or_timeout",
      retryable: true,
    });
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(directory, "pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    await client.onModuleDestroy();
  });
  it("shutdown aborts the active child and rejects further subprocesses", async () => {
    const { client } = await createClient(
      "process.stdin.resume();setInterval(()=>{},1000);",
    );
    const pending = client.cluster(
      request,
      new AbortController().signal,
      () => undefined,
    );
    const rejected = expect(pending).rejects.toMatchObject({ retryable: true });
    await client.onModuleDestroy();
    await rejected;
    await expect(
      client.cluster(request, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: "clustering_shutting_down" });
  });
});
