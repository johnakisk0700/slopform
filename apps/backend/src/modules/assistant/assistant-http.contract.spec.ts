import type { AddressInfo } from "node:net";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AssistantJobsService } from "./assistant-jobs.service.js";
import type { AssistantService } from "./assistant.service.js";
import type { AssistantStreamRelay } from "./assistant-stream.relay.js";

vi.mock("@clerk/express", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...original,
    clerkMiddleware:
      () => (_request: unknown, _response: unknown, next: () => void) =>
        next(),
    getAuth: () => ({ isAuthenticated: true, userId: "user_admin123" }),
  };
});

const threadId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const turnId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const requestId = "a8e94f93-9909-4cf2-b580-3b55c287a452";
const queuedTurn = {
  id: turnId,
  requestId,
  sequence: 1,
  status: "queued" as const,
  model: "google/gemini-3.6-flash" as const,
  effort: "low" as const,
  serviceTier: "standard" as const,
  user: { role: "user" as const, content: "Hello" },
  assistant: null,
  partial: null,
  reasoning: null,
  toolCalls: [],
  usage: null,
  error: null,
  attempt: 1,
  createdAt: "2026-07-23T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
};
const queuedThread = {
  id: threadId,
  title: "Hello",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
  turns: [queuedTurn],
};

describe("assistant HTTP contract", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let jobs: AssistantJobsService;
  let assistant: AssistantService;
  let streams: AssistantStreamRelay;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@127.0.0.1:5432/join_the_six_test",
    );
    vi.stubEnv("MONGODB_URI", "mongodb://127.0.0.1:27017/join_the_six_test");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_example");
    vi.stubEnv("CLERK_ADMIN_USER_IDS", "user_admin123");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("LOG_LEVEL", "silent");

    const [bootstrap, types] = await Promise.all([
      import("../../bootstrap-http.js"),
      importAssistantTypes(),
    ]);
    app = await bootstrap.createHttpApplication();
    jobs = app.get(types.AssistantJobsService);
    assistant = app.get(types.AssistantService);
    streams = app.get(types.AssistantStreamRelay);
    vi.spyOn(jobs, "createThreadAndEnqueue").mockResolvedValue(queuedThread);
    vi.spyOn(jobs, "branchThreadAndEnqueue").mockResolvedValue(queuedThread);
    vi.spyOn(assistant, "getThread").mockResolvedValue(queuedThread);
    vi.spyOn(assistant, "list").mockResolvedValue({ items: [] });
    vi.spyOn(assistant, "getTurn").mockResolvedValue(queuedTurn);

    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("publishes thread, turn, poll and retry schemas in OpenAPI", async () => {
    const response = await fetch(`${baseUrl}/api/openapi.json`);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(response.status).toBe(200);
    expect(document.paths["/api/v1/assistant/threads"]).toMatchObject({
      get: expect.any(Object),
      post: expect.any(Object),
    });
    expect(document.paths["/api/v1/assistant/threads/{id}"]).toHaveProperty(
      "get",
    );
    expect(
      document.paths["/api/v1/assistant/threads/{id}/turns"],
    ).toHaveProperty("post");
    expect(
      document.paths["/api/v1/assistant/threads/{id}/branches"],
    ).toHaveProperty("post");
    expect(
      document.paths[
        "/api/v1/assistant/threads/{threadId}/turns/{turnId}/retry"
      ],
    ).toHaveProperty("post");
    expect(
      document.paths[
        "/api/v1/assistant/threads/{threadId}/turns/{turnId}/stream"
      ],
    ).toHaveProperty("get");
  });

  it("streams replayable live frames after authorizing the durable turn", async () => {
    vi.spyOn(streams, "follow").mockImplementation(async function* () {
      yield { kind: "reset" };
      yield { kind: "text", accumulated: "Live answer" };
      yield { kind: "done" };
    });

    const response = await fetch(
      `${baseUrl}/api/v1/assistant/threads/${threadId}/turns/${turnId}/stream`,
      { headers: { accept: "text/event-stream" } },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(body).toContain(
      'data: {"kind":"snapshot","attempt":1,"status":"queued","accumulated":null,"reasoning":null,"toolCalls":[]}',
    );
    expect(body).toContain(
      'data: {"attempt":1,"kind":"text","accumulated":"Live answer"}',
    );
    expect(body).toContain('data: {"attempt":1,"kind":"done"}');
    expect(assistant.getTurn).toHaveBeenCalledWith(
      threadId,
      turnId,
      "user_admin123",
    );
  });

  it("creates and resumes an owner-bound durable thread", async () => {
    const createResponse = await fetch(`${baseUrl}/api/v1/assistant/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, content: "Hello" }),
    });
    const getResponse = await fetch(
      `${baseUrl}/api/v1/assistant/threads/${threadId}`,
    );

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toEqual(queuedThread);
    expect(jobs.createThreadAndEnqueue).toHaveBeenCalledWith(
      { requestId, effort: "low", serviceTier: "standard", content: "Hello" },
      "user_admin123",
      expect.any(String),
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(queuedThread);
    expect(assistant.getThread).toHaveBeenCalledWith(threadId, "user_admin123");
  });

  it("rejects a missing idempotency key at the real validation boundary", async () => {
    const response = await fetch(`${baseUrl}/api/v1/assistant/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    });
    expect(response.status).toBe(400);
  });

  it("branches through an owner-bound idempotent creation request", async () => {
    const branchRequestId = "060580dd-b226-4bc6-adc6-0236c10a0b4a";
    const response = await fetch(
      `${baseUrl}/api/v1/assistant/threads/${threadId}/branches`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: branchRequestId,
          sourceTurnId: turnId,
          content: "Edited question",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(jobs.branchThreadAndEnqueue).toHaveBeenCalledWith(
      threadId,
      {
        requestId: branchRequestId,
        sourceTurnId: turnId,
        effort: "low",
        serviceTier: "standard",
        content: "Edited question",
      },
      "user_admin123",
      expect.any(String),
    );
  });
});

async function importAssistantTypes() {
  const [
    { AssistantJobsService },
    { AssistantService },
    { AssistantStreamRelay },
  ] = await Promise.all([
    import("./assistant-jobs.service.js"),
    import("./assistant.service.js"),
    import("./assistant-stream.relay.js"),
  ]);
  return { AssistantJobsService, AssistantService, AssistantStreamRelay };
}
