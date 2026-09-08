import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TOPIC_ANALYSIS_CONFIGURATION,
  type TopicAnalysisStatus,
} from "./topic-analysis.schemas.js";
import type { TopicAnalysisService } from "./topic-analysis.service.js";

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  userId: "user_admin123",
}));
vi.mock("@clerk/express", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/express")>()),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  getAuth: () => auth,
}));
const campaignId = "924a7d11-f894-48a9-a01a-983ff3cf27f2";
const analysisId = "deedba6f-3f51-42bd-bd63-4c6a2084a915";
const status: TopicAnalysisStatus = {
  id: analysisId,
  campaignId,
  status: "pending",
  stage: "queued",
  snapshotHash: "abc",
  configuration: TOPIC_ANALYSIS_CONFIGURATION,
  inputScope: "active_extracted_notes",
  documentCount: 1,
  attempts: 0,
  reservedRequests: 0,
  observedResponses: 0,
  observedPromptTokens: 0,
  observedCostUsd: null,
  errorCode: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  completedAt: null,
};

describe("topic analysis HTTP boundary", () => {
  let app: NestExpressApplication;
  let analyses: TopicAnalysisService;
  let url: string;
  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/topic_http_test",
      MONGODB_URI: "mongodb://127.0.0.1:27017/topic_http_test",
      REDIS_URL: "redis://127.0.0.1:6379",
      WEB_ORIGIN: "http://localhost:3000",
      CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_ADMIN_USER_IDS: "user_admin123",
      AUTH_DEV_BYPASS: "false",
      FEEDBACK_TOPIC_ANALYSIS_ENABLED: "false",
      LOG_LEVEL: "silent",
    }))
      vi.stubEnv(key, value);
    const [{ createHttpApplication }, { TopicAnalysisService }] =
      await Promise.all([
        import("../../../bootstrap-http.js"),
        import("./topic-analysis.service.js"),
      ]);
    app = await createHttpApplication();
    analyses = app.get(TopicAnalysisService);
    await app.listen(0, "127.0.0.1");
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/feedback/campaigns/${campaignId}/topic-analyses`;
  }, 20_000);
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  }, 15_000);

  it("requires an authenticated allowlisted admin on all routes", async () => {
    auth.isAuthenticated = false;
    for (const [path, method] of [
      ["", "POST"],
      [`/${analysisId}`, "GET"],
      [`/${analysisId}/result`, "GET"],
    ] as const)
      expect((await fetch(url + path, { method })).status).toBe(401);
    auth.isAuthenticated = true;
    auth.userId = "user_other";
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    auth.userId = "user_admin123";
  });
  it("rejects starts when feature disabled before touching storage", async () => {
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
  });
  it("validates path IDs and returns accepted status with the verified principal", async () => {
    const start = vi.spyOn(analyses, "start").mockResolvedValue(status);
    expect(
      (await fetch(url.replace(campaignId, "invalid"), { method: "POST" }))
        .status,
    ).toBe(400);
    const response = await fetch(url, { method: "POST" });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    expect(start).toHaveBeenCalledExactlyOnceWith(campaignId, "user_admin123");
  });
});
