import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createFeedbackBurstHeaders } from "./feedback-burst-auth.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("createFeedbackBurstHeaders", () => {
  it("reads a refreshed bearer token for every request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "feedback-auth-"));
    directories.push(directory);
    const tokenFile = path.join(directory, "token");
    await writeFile(tokenFile, "first-token\n", { mode: 0o600 });

    const headers = createFeedbackBurstHeaders({
      tokenFile,
      correlationId: "run-1",
    });

    assert.equal(headers.authorization, "Bearer first-token");
    await writeFile(tokenFile, "second-token\n", { mode: 0o600 });
    assert.equal(headers.authorization, "Bearer second-token");
    assert.deepEqual(
      { ...headers },
      {
        "content-type": "application/json",
        "x-request-id": "run-1",
        authorization: "Bearer second-token",
      },
    );
  });

  it("rejects ambiguous and empty token sources", async () => {
    assert.throws(
      () =>
        createFeedbackBurstHeaders({
          token: "static-token",
          tokenFile: "/tmp/token",
          correlationId: "run-1",
        }),
      /either --token/,
    );

    const directory = await mkdtemp(path.join(tmpdir(), "feedback-auth-"));
    directories.push(directory);
    const tokenFile = path.join(directory, "token");
    await writeFile(tokenFile, "\n", { mode: 0o600 });

    assert.throws(
      () => createFeedbackBurstHeaders({ tokenFile, correlationId: "run-1" }),
      /Bearer token file is empty/,
    );
  });
});
