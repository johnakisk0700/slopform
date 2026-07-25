import type { AddressInfo } from "node:net";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/express", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...original,
    clerkMiddleware:
      () => (_request: unknown, _response: unknown, next: () => void) => {
        next();
      },
    getAuth: () => ({ isAuthenticated: false }),
  };
});

const webhookSecret = "webhook-secret-that-is-at-least-32-characters";
const validPayload = {
  event: "messages.update",
  sessionId: "provider-session-value",
  timestamp: 1_747_775_431_467,
  data: {
    update: { status: 3 },
    key: {
      id: "provider-message-id",
      remoteJid: "306900000001@s.whatsapp.net",
      fromMe: true,
    },
  },
};

describe("Wasender webhook HTTP contract", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@127.0.0.1:5432/join_the_six_test",
    );
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_example");
    vi.stubEnv("CLERK_ADMIN_USER_IDS", "user_admin123");
    vi.stubEnv("WASENDER_WEBHOOK_ENABLED", "true");
    vi.stubEnv("WASENDER_WEBHOOK_SECRET", webhookSecret);
    vi.stubEnv("LOG_LEVEL", "silent");

    const { createHttpApplication } = await import("../../bootstrap-http.js");
    app = await createHttpApplication();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("publishes the opt-in public endpoint in generated OpenAPI", async () => {
    const response = await fetch(`${baseUrl}/api/openapi.json`);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths["/api/v1/webhooks/wasender"]).toHaveProperty("post");
  });

  it("accepts a signed status event without requiring Clerk", async () => {
    const response = await postWebhook(validPayload, webhookSecret);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      eventCount: 1,
    });
  });

  it("rejects invalid signatures before acknowledging the provider", async () => {
    const response = await postWebhook(validPayload, "x".repeat(32));

    expect(response.status).toBe(401);
  });

  it("rejects unsupported webhook payloads at the real Zod boundary", async () => {
    const response = await postWebhook(
      { event: "contacts.upsert", timestamp: 123, data: {} },
      webhookSecret,
    );

    expect(response.status).toBe(400);
  });

  function postWebhook(body: unknown, signature: string): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/webhooks/wasender`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      body: JSON.stringify(body),
    });
  }
});
